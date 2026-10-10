import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.js";

// Verifies a Google Identity Services ID token. The token is signed by Google;
// we check the signature against Google's published keys, the issuer, the
// audience (our client ID), expiry and that the email is verified. No client
// secret is needed for this flow.
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export interface GoogleProfile {
  email: string;
  name: string;
}

export async function verifyGoogleCredential(credential: string): Promise<GoogleProfile> {
  if (!config.googleClientId) throw new Error("Google sign-in is not configured");
  const { payload } = await jwtVerify(credential, JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: config.googleClientId,
  });
  if (payload.email_verified !== true || typeof payload.email !== "string") {
    throw new Error("The Google account email is not verified");
  }
  if (config.googleAllowedDomains.length > 0) {
    const domain = payload.email.split("@")[1]?.toLowerCase() ?? "";
    if (!config.googleAllowedDomains.includes(domain)) {
      throw new Error(`Sign-in is limited to ${config.googleAllowedDomains.join(", ")} accounts`);
    }
  }
  return { email: payload.email.toLowerCase(), name: typeof payload.name === "string" ? payload.name : payload.email };
}
