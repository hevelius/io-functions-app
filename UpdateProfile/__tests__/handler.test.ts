/* tslint:disable: no-any */

import * as lolex from "lolex";

import { none, some } from "fp-ts/lib/Option";

import * as df from "durable-functions";

import { fromLeft, taskEither } from "fp-ts/lib/TaskEither";
import { context as contextMock } from "../../__mocks__/durable-functions";
import {
  aEmailChanged,
  aFiscalCode,
  aProfile,
  aRetrievedProfile
} from "../../__mocks__/mocks";
import { OrchestratorInput as UpsertedProfileOrchestratorInput } from "../../UpsertedProfileOrchestrator/handler";
import { UpdateProfileHandler } from "../handler";

// tslint:disable-next-line: no-let
let clock: any;
beforeEach(() => {
  (df.getClient as any).mockClear();
  (df as any).mockStartNew.mockClear();
  // We need to mock time to test token expiration.
  clock = lolex.install({ now: Date.now() });
});
afterEach(() => {
  clock = clock.uninstall();
});

describe("UpdateProfileHandler", () => {
  it("should return a query error when an error occurs retrieving the existing profile", async () => {
    const profileModelMock = {
      findLastVersionByModelId: jest.fn(() => fromLeft({}))
    };

    const updateProfileHandler = UpdateProfileHandler(profileModelMock as any);

    const result = await updateProfileHandler(
      contextMock as any,
      undefined as any,
      {} as any
    );

    expect(result.kind).toBe("IResponseErrorQuery");
  });

  it("should return a not found error if can't find an existing profile", async () => {
    const profileModelMock = {
      findLastVersionByModelId: jest.fn(() => taskEither.of(none))
    };

    const updateProfileHandler = UpdateProfileHandler(profileModelMock as any);

    const result = await updateProfileHandler(
      contextMock as any,
      undefined as any,
      {} as any
    );

    expect(result.kind).toBe("IResponseErrorNotFound");
  });

  it("should return a conflict error if the verion in the payload is not the latest", async () => {
    const profileModelMock = {
      findLastVersionByModelId: jest.fn(() =>
        taskEither.of(some(aRetrievedProfile))
      )
    };

    const updateProfileHandler = UpdateProfileHandler(profileModelMock as any);

    const result = await updateProfileHandler(
      contextMock as any,
      undefined as any,
      {
        version: 1
      } as any
    );

    expect(result.kind).toBe("IResponseErrorConflict");
  });

  it("should set isEmailValidated to false if the email is changed", async () => {
    const profileModelMock = {
      findLastVersionByModelId: jest.fn(() =>
        // Return a profile with a validated email
        taskEither.of(some({ ...aRetrievedProfile, isEmailValidated: true }))
      ),
      update: jest.fn(_ => taskEither.of({ ...aRetrievedProfile, ..._ }))
    };

    const updateProfileHandler = UpdateProfileHandler(profileModelMock as any);

    const result = await updateProfileHandler(contextMock as any, aFiscalCode, {
      ...aProfile,
      email: aEmailChanged
    });

    expect(result.kind).toBe("IResponseSuccessJson");
    if (result.kind === "IResponseSuccessJson") {
      expect(result.value).toEqual(
        expect.objectContaining({
          email: aEmailChanged,
          is_email_validated: false
        })
      );
    }
  });

  it("should start the orchestrator with the appropriate input after the profile has been created", async () => {
    const updatedProfile = {
      ...aRetrievedProfile,
      email: aEmailChanged,
      isEmailValidated: false
    };
    const upsertedProfileOrchestratorInput = UpsertedProfileOrchestratorInput.encode(
      {
        newProfile: updatedProfile,
        oldProfile: aRetrievedProfile,
        updatedAt: new Date()
      }
    );

    const profileModelMock = {
      findLastVersionByModelId: jest.fn(() =>
        taskEither.of(some(aRetrievedProfile))
      ),
      update: jest.fn(() => taskEither.of(updatedProfile))
    };

    const updateProfileHandler = UpdateProfileHandler(profileModelMock as any);

    await updateProfileHandler(contextMock as any, aFiscalCode, {
      ...aProfile,
      email: aEmailChanged
    });

    expect(df.getClient).toHaveBeenCalledTimes(1);

    const dfClient = df.getClient(contextMock);
    expect(dfClient.startNew).toHaveBeenCalledWith(
      "UpsertedProfileOrchestrator",
      undefined,
      upsertedProfileOrchestratorInput
    );
  });
});
