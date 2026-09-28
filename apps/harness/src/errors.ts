import { Data, Effect } from "effect";

/** A request the API refuses, answered as `Api.ApiError` JSON. */
export class ApiFailure extends Data.TaggedError("ApiFailure")<{
  readonly status: 400 | 401 | 403 | 404 | 409 | 500;
  readonly code: string;
  readonly message: string;
}> {}

export const fail = (status: ApiFailure["status"], code: string, message: string) =>
  Effect.fail(new ApiFailure({ status, code, message }));
