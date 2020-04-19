import { Context } from "@azure/functions";

import * as express from "express";

import {
  SENDER_SERVICE_COLLECTION_NAME,
  SenderServiceModel
} from "io-functions-commons/dist/src/models/sender_service";
import * as documentDbUtils from "io-functions-commons/dist/src/utils/documentdb";
import { getRequiredStringEnv } from "io-functions-commons/dist/src/utils/env";
import { secureExpressApp } from "io-functions-commons/dist/src/utils/express";
import { setAppContext } from "io-functions-commons/dist/src/utils/middlewares/context_middleware";

import createAzureFunctionHandler from "io-functions-express/dist/src/createAzureFunctionsHandler";

import { documentClient } from "../utils/cosmosdb";
import { GetServicesForRecipient } from "./handler";

// Setup Express
const app = express();
secureExpressApp(app);

const cosmosDbName = getRequiredStringEnv("COSMOSDB_NAME");

const documentDbDatabaseUrl = documentDbUtils.getDatabaseUri(cosmosDbName);
const senderServicesCollectionUrl = documentDbUtils.getCollectionUri(
  documentDbDatabaseUrl,
  SENDER_SERVICE_COLLECTION_NAME
);

const senderServiceModel = new SenderServiceModel(
  documentClient,
  senderServicesCollectionUrl
);

app.get(
  "/api/v1/profiles/:fiscalcode/sender-services",
  GetServicesForRecipient(senderServiceModel)
);

const azureFunctionHandler = createAzureFunctionHandler(app);

// Binds the express app to an Azure Function handler
function httpStart(context: Context): void {
  setAppContext(app, context);
  azureFunctionHandler(context);
}

export default httpStart;
