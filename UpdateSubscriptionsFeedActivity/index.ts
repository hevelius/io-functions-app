﻿import * as crypto from "crypto";

import * as t from "io-ts";

import { AzureFunction, Context } from "@azure/functions";
import { createTableService, TableUtilities } from "azure-storage";

import { readableReport } from "@pagopa/ts-commons/lib/reporters";
import { FiscalCode } from "@pagopa/ts-commons/lib/strings";

import { ServiceId } from "@pagopa/io-functions-commons/dist/generated/definitions/ServiceId";

import { isNone } from "fp-ts/lib/Option";
import { deleteTableEntity, insertTableEntity } from "../utils/storage";

import { getConfigOrThrow } from "../utils/config";

const config = getConfigOrThrow();

const tableService = createTableService(config.QueueStorageConnection);

const insertEntity = insertTableEntity(
  tableService,
  config.SUBSCRIPTIONS_FEED_TABLE
);

const deleteEntity = deleteTableEntity(
  tableService,
  config.SUBSCRIPTIONS_FEED_TABLE
);

const eg = TableUtilities.entityGenerator;

/**
 * Input data for this activity function, we need information about the kind
 * of subscription event and the affected user profile.
 */
const Input = t.intersection([
  t.interface({
    // fiscal code of the user affected by this update
    fiscalCode: FiscalCode,
    // whether the service has been subscribed or unsubscribed
    operation: t.union([t.literal("SUBSCRIBED"), t.literal("UNSUBSCRIBED")]),
    // the time (millis epoch) of the update
    updatedAt: t.number,
    // updated version of the profile
    version: t.number
  }),
  t.union([
    t.interface({
      // a profile subscription event
      subscriptionKind: t.literal("PROFILE")
    }),
    t.interface({
      // the updated service
      serviceId: ServiceId,
      // a service subscription event
      subscriptionKind: t.literal("SERVICE")
    })
  ])
]);

export type Input = t.TypeOf<typeof Input>;

// When the function starts, attempt to create the table if it does not exist
// Note that we cannot log anything just yet since we don't have a Context
tableService.createTableIfNotExists(config.SUBSCRIPTIONS_FEED_TABLE, () => 0);

/**
 * Updates the subscrption status of a user.
 *
 * User subscribed or unsubscribed events are stored as empty entities in an
 * Azure storage table.
 *
 * The entity key is composed by the day of the event, the service ID (if it's
 * a service subscription event), a character that indicates whether it's a
 * subscribed (S) or unsubscribed (U) event and the SHA256 hash of the fiscal
 * code of the user.
 *
 * For each day, (optionally) service and user, either the S or the U key exist,
 * but not both (it would not make sense).
 *
 * When the key does not include a service ID, it refers to a profile
 * subscription event, meaning the user registered to IO (subscribed) or deleted
 * her account (unsubscribed).
 * When the key includes the service ID, it refers to a service subscription
 * event, meaning the user activated (subscribed) or deactivated (unsubscribed)
 * a specific service.
 */
async function updateSubscriptionStatus(
  context: Context,
  logPrefix: string,
  version: number,
  delPartitionKey: string,
  delKey: string,
  insPartitionKey: string,
  insKey: string
): Promise<true> {
  // First we try to delete a previous (un)subscriptions operation
  // from the subscription feed entries for the current day
  context.log.verbose(`${logPrefix}|KEY=${delKey}|Deleting entity`);
  const { e1: maybeError, e2: uResponse } = await deleteEntity({
    PartitionKey: eg.String(delPartitionKey),
    RowKey: eg.String(delKey)
  });

  // If deleteEntity is successful it means the user
  // previously made an opposite choice (in the same day).
  // Since we're going to expose only the delta for this day,
  // and we've just deleted the opposite operation, we go on here.
  if (isNone(maybeError)) {
    return true;
  }

  if (maybeError.isSome() && uResponse.statusCode !== 404) {
    // retry
    context.log.error(`${logPrefix}|ERROR=${maybeError.value.message}`);
    throw maybeError.value;
  }

  // If deleteEntity has not found any entry,
  // we insert the new (un)subscription entry into the feed
  context.log.verbose(`${logPrefix}|KEY=${insKey}|Inserting entity`);
  const { e1: resultOrError, e2: sResponse } = await insertEntity({
    PartitionKey: eg.String(insPartitionKey),
    RowKey: eg.String(insKey),
    version: eg.Int32(version)
  });
  if (resultOrError.isLeft() && sResponse.statusCode !== 409) {
    // retry
    context.log.error(`${logPrefix}|ERROR=${resultOrError.value.message}`);
    throw resultOrError.value;
  }

  return true;
}

const activityFunction: AzureFunction = async (
  context: Context,
  rawInput: unknown
): Promise<string> => {
  const decodedInputOrError = Input.decode(rawInput);
  if (decodedInputOrError.isLeft()) {
    context.log.error(
      `UpdateServiceSubscriptionFeedActivity|Cannot parse input|ERROR=${readableReport(
        decodedInputOrError.value
      )}`
    );
    return "FAILURE";
  }

  const decodedInput = decodedInputOrError.value;

  const { fiscalCode, operation, updatedAt, version } = decodedInput;

  // The date part of the key will be in UTC time zone, with format: YYYY-MM-DD
  const utcTodayPrefix = new Date(updatedAt).toISOString().substring(0, 10);

  // Create a SHA256 hash of the fiscal code
  // see https://nodejs.org/api/crypto.html#crypto_crypto_createhash_algorithm_options
  const fiscalCodeHash = crypto
    .createHash("sha256")
    .update(fiscalCode)
    .digest("hex");

  const logPrefix = `UpdateSubscriptionFeedActivity|PROFILE=${fiscalCode}|OPERATION=${operation}|PROFILE=${fiscalCode}`;

  // Entity keys have the following format
  //
  // Profile subscription events: P-<DATE>-<EVENT>-<HASH>
  // Service subscription events: S-<DATE>-<SERVICE_ID>-<EVENT>-<HASH>
  //
  // Where:
  //
  // * DATE is "YYYY-MM-DD" (UTC)
  // * SERVICE_ID is the service ID that the user subscribed/unsubscribed
  // * EVENT is either "S" for subscription events or "U" for unsubscriptions
  // * HASH is the hex encoded SHA256 hash of the fiscal code
  //
  const sPartitionKey =
    decodedInput.subscriptionKind === "PROFILE"
      ? `P-${utcTodayPrefix}-S`
      : `S-${utcTodayPrefix}-${decodedInput.serviceId}-S`;
  const uPartitionKey =
    decodedInput.subscriptionKind === "PROFILE"
      ? `P-${utcTodayPrefix}-U`
      : `S-${utcTodayPrefix}-${decodedInput.serviceId}-U`;

  const sKey = `${sPartitionKey}-${fiscalCodeHash}`;
  const uKey = `${uPartitionKey}-${fiscalCodeHash}`;

  if (operation === "SUBSCRIBED") {
    // we delete the entry from the unsubscriptions and we add it to the
    // subscriptions
    await updateSubscriptionStatus(
      context,
      logPrefix,
      version,
      uPartitionKey,
      uKey,
      sPartitionKey,
      sKey
    );
  } else {
    // we delete the entry from the subscriptions and we add it to the
    // unsubscriptions
    await updateSubscriptionStatus(
      context,
      logPrefix,
      version,
      sPartitionKey,
      sKey,
      uPartitionKey,
      uKey
    );
  }

  return "SUCCESS";
};

export default activityFunction;
