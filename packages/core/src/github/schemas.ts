import { Schema } from "effect";

export const GitHubUser = Schema.Struct({
  id: Schema.Number,
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatar_url: Schema.String,
});
export type GitHubUser = typeof GitHubUser.Type;

export const GitHubRepo = Schema.Struct({
  id: Schema.Number,
  full_name: Schema.String,
  name: Schema.String,
  private: Schema.Boolean,
  default_branch: Schema.String,
  html_url: Schema.String,
});
export type GitHubRepo = typeof GitHubRepo.Type;

export const GitHubInstallation = Schema.Struct({
  id: Schema.Number,
  account: Schema.NullOr(Schema.Struct({ login: Schema.String })),
});
export type GitHubInstallation = typeof GitHubInstallation.Type;

export const PullRequest = Schema.Struct({ number: Schema.Number, html_url: Schema.String });
export type PullRequest = typeof PullRequest.Type;

export const InstallationTokenResponse = Schema.Struct({ token: Schema.String, expires_at: Schema.String });

/** GitHub answers the OAuth token endpoint with 200 even on errors, so every field is optional. */
export const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  refresh_token: Schema.optional(Schema.String),
  refresh_token_expires_in: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});
export type OAuthTokenResponse = typeof OAuthTokenResponse.Type;
