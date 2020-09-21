import * as express from "express";

import { Context } from "@azure/functions";

import { isLeft } from "fp-ts/lib/Either";

import {
  IResponseErrorNotFound,
  IResponseSuccessJson,
  ResponseErrorNotFound,
  ResponseSuccessJson
} from "italia-ts-commons/lib/responses";
import { FiscalCode } from "italia-ts-commons/lib/strings";

import {
  IResponseErrorQuery,
  ResponseErrorQuery
} from "io-functions-commons/dist/src/utils/response";

import { ContextMiddleware } from "io-functions-commons/dist/src/utils/middlewares/context_middleware";
import { FiscalCodeMiddleware } from "io-functions-commons/dist/src/utils/middlewares/fiscalcode";
import {
  withRequestMiddlewares,
  wrapRequestHandler
} from "io-functions-commons/dist/src/utils/request_middleware";

import { isSome } from "fp-ts/lib/Option";
import { UserDataProcessing as UserDataProcessingApi } from "io-functions-commons/dist/generated/definitions/UserDataProcessing";
import { UserDataProcessingChoice } from "io-functions-commons/dist/generated/definitions/UserDataProcessingChoice";
import {
  makeUserDataProcessingId,
  UserDataProcessingModel
} from "io-functions-commons/dist/src/models/user_data_processing";
import { RequiredParamMiddleware } from "io-functions-commons/dist/src/utils/middlewares/required_param";
import { toUserDataProcessingApi } from "../utils/user_data_processings";

/**
 * Type of a GetUserDataProcessing handler.
 */
type IGetUserDataProcessingHandler = (
  context: Context,
  fiscalCode: FiscalCode,
  userDataProcessingChoice: UserDataProcessingChoice
) => Promise<
  // tslint:disable-next-line: max-union-size
  | IResponseSuccessJson<UserDataProcessingApi>
  | IResponseErrorQuery
  | IResponseErrorNotFound
>;

export function GetUserDataProcessingHandler(
  userDataProcessingModel: UserDataProcessingModel
): IGetUserDataProcessingHandler {
  return async (context, fiscalCode, choice) => {
    const logPrefix = `GetUserDataProcessingHandler|FISCAL_CODE=${fiscalCode}`;
    const id = makeUserDataProcessingId(choice, fiscalCode);
    const maybeResultOrError = await userDataProcessingModel
      .findLastVersionByModelId([id, fiscalCode])
      .run();
    if (isLeft(maybeResultOrError)) {
      const failure = maybeResultOrError.value;

      context.log.error(`${logPrefix}|ERROR=${failure.kind}`);
      if (
        failure.kind === "COSMOS_ERROR_RESPONSE" &&
        failure.error.code === 404
      ) {
        return ResponseErrorNotFound(
          "Not Found while retrieving User Data Processing",
          `${failure.error.message}`
        );
      } else {
        return ResponseErrorQuery(
          "Error while retrieving a user data processing",
          failure
        );
      }
    }

    const maybeUserDataProcessing = maybeResultOrError.value;
    if (isSome(maybeUserDataProcessing)) {
      const userDataProc = maybeUserDataProcessing.value;
      return ResponseSuccessJson(toUserDataProcessingApi(userDataProc));
    } else {
      return ResponseErrorNotFound(
        "Error while retrieving user data processing",
        "Not Found"
      );
    }
  };
}

/**
 * Wraps a GetUserDataProcessing handler inside an Express request handler.
 */
export function GetUserDataProcessing(
  userDataProcessingModel: UserDataProcessingModel
): express.RequestHandler {
  const handler = GetUserDataProcessingHandler(userDataProcessingModel);

  const middlewaresWrap = withRequestMiddlewares(
    ContextMiddleware(),
    FiscalCodeMiddleware,
    RequiredParamMiddleware("choice", UserDataProcessingChoice)
  );
  return wrapRequestHandler(middlewaresWrap(handler));
}
