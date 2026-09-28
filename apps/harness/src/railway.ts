import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import type { ProvisionedSandboxes } from "@factory/core";
import { Context, Data, Effect, Layer, Schema } from "effect";

const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

/** The environment sandboxes run in, next to the factory's own. */
export const SANDBOX_ENVIRONMENT = "agents";

export class RailwayError extends Data.TaggedError("RailwayError")<{ readonly message: string }> {}

const GraphQLResponse = <A, I>(data: Schema.Schema<A, I>) =>
  Schema.Struct({
    data: Schema.optional(Schema.NullOr(data)),
    errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
  });

const Environments = Schema.Struct({
  environments: Schema.Struct({
    edges: Schema.Array(Schema.Struct({ node: Schema.Struct({ id: Schema.String, name: Schema.String }) })),
  }),
});
const CreatedEnvironment = Schema.Struct({ environmentCreate: Schema.Struct({ id: Schema.String, name: Schema.String }) });
const CreatedToken = Schema.Struct({ projectTokenCreate: Schema.String });

/**
 * Railway's public API, used once by the setup page: with a token the person
 * pastes (and that is never stored), it finds or creates the `agents`
 * environment and mints a project token scoped to it. The runner then creates
 * sandboxes with that narrow token only, so it can never touch production.
 */
export class RailwayApi extends Context.Tag("@factory/RailwayApi")<
  RailwayApi,
  {
    readonly provisionSandboxes: (accountToken: string, projectId: string) => Effect.Effect<ProvisionedSandboxes, RailwayError>;
  }
>() {
  static readonly Live = Layer.effect(
    RailwayApi,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      const graphql = <A, I>(
        token: string,
        query: string,
        variables: Record<string, unknown>,
        data: Schema.Schema<A, I>,
      ): Effect.Effect<A, RailwayError> =>
        Effect.gen(function* () {
          const res = yield* client.execute(
            HttpClientRequest.post(RAILWAY_API).pipe(
              HttpClientRequest.bearerToken(token),
              HttpClientRequest.setHeader("User-Agent", "factory-on-rails"),
              HttpClientRequest.bodyUnsafeJson({ query, variables }),
            ),
          );
          if (res.status === 401 || res.status === 403) {
            return yield* new RailwayError({ message: "Railway did not accept that token." });
          }
          const body = yield* HttpClientResponse.schemaBodyJson(GraphQLResponse(data))(res);
          if (body.errors?.length || body.data == null) {
            return yield* new RailwayError({ message: describe(body.errors?.[0]?.message) });
          }
          return body.data;
        }).pipe(
          Effect.catchTags({
            RequestError: (e) => Effect.fail(new RailwayError({ message: `Could not reach Railway: ${e.message}` })),
            ResponseError: (e) => Effect.fail(new RailwayError({ message: `Railway answered ${e.response.status}.` })),
            ParseError: () => Effect.fail(new RailwayError({ message: "Unexpected answer from Railway." })),
          }),
        );

      return {
        provisionSandboxes: (token, projectId) =>
          Effect.gen(function* () {
            const { environments } = yield* graphql(
              token,
              "query ($projectId: String!) { environments(projectId: $projectId) { edges { node { id name } } } }",
              { projectId },
              Environments,
            );
            const existing = environments.edges.map((e) => e.node).find((env) => env.name === SANDBOX_ENVIRONMENT);
            // A new environment without a source starts empty: sandboxes are all that will live there.
            const environment =
              existing ??
              (yield* graphql(
                token,
                "mutation ($input: EnvironmentCreateInput!) { environmentCreate(input: $input) { id name } }",
                { input: { projectId, name: SANDBOX_ENVIRONMENT, skipInitialDeploys: true } },
                CreatedEnvironment,
              )).environmentCreate;
            const { projectTokenCreate } = yield* graphql(
              token,
              "mutation ($input: ProjectTokenCreateInput!) { projectTokenCreate(input: $input) }",
              { input: { projectId, environmentId: environment.id, name: "factory-on-rails sandboxes" } },
              CreatedToken,
            );
            return { projectId, environmentId: environment.id, environmentName: environment.name, token: projectTokenCreate };
          }),
      };
    }),
  );
}

/** Railway's GraphQL errors, in words that say what to do about them. */
const describe = (message: string | undefined): string => {
  if (!message) return "Railway refused the request.";
  // Railway answers a bad or unrelated token with "Project not found" rather than a 401.
  if (/not authorized|unauthorized|forbidden|project not found/i.test(message)) {
    return "That token can't manage this project. Use an account or workspace token with access to it (a project token won't do).";
  }
  return `Railway: ${message}`;
};
