// Browser side of the passkey ceremonies. The server (src/auth_api.rs) hands
// out WebAuthn options under `options.publicKey` plus a `flow_id`; the
// browser runs the ceremony and posts the credential back with the flow id.
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { apiJson } from "./auth";

export { browserSupportsWebAuthn };

interface RegistrationStart {
  flow_id: string;
  options: { publicKey: PublicKeyCredentialCreationOptionsJSON };
}

interface AuthenticationStart {
  flow_id: string;
  options: { publicKey: PublicKeyCredentialRequestOptionsJSON; mediation?: string };
}

/** A sensible default name for a new passkey, from the browser's user agent. */
export function defaultKeyName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Mac OS/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /Linux/.test(ua)
            ? "Linux"
            : "device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "browser";
  return `${browser} on ${os}`;
}

function friendly(err: unknown): Error {
  const e = err as { name?: string; message?: string };
  if (e?.name === "NotAllowedError") {
    return new Error("The passkey prompt was cancelled or timed out.");
  }
  if (e?.name === "InvalidStateError") {
    return new Error("This device already has a passkey for this account.");
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Run a registration ceremony: POST startUrl → browser creates the passkey →
 * POST finishUrl. Returns the finish response (user, maybe recovery_code).
 */
export async function registerPasskey<T = unknown>(
  startUrl: string,
  startBody: unknown,
  finishUrl: string,
  keyName: string,
): Promise<T> {
  if (!browserSupportsWebAuthn()) throw new Error("This browser does not support passkeys.");
  const start = await apiJson<RegistrationStart>(startUrl, "POST", startBody);
  let credential;
  try {
    credential = await startRegistration({ optionsJSON: start.options.publicKey });
  } catch (err) {
    throw friendly(err);
  }
  return apiJson<T>(finishUrl, "POST", {
    flow_id: start.flow_id,
    credential,
    key_name: keyName,
  });
}

/** Sign in. With a username the browser is told which credentials qualify; without, any passkey for this site. */
export async function signInWithPasskey(username?: string): Promise<unknown> {
  if (!browserSupportsWebAuthn()) throw new Error("This browser does not support passkeys.");
  const start = await apiJson<AuthenticationStart>(
    "/api/auth/login/start",
    "POST",
    username ? { username } : {},
  );
  let credential;
  try {
    credential = await startAuthentication({ optionsJSON: start.options.publicKey });
  } catch (err) {
    throw friendly(err);
  }
  return apiJson("/api/auth/login/finish", "POST", { flow_id: start.flow_id, credential });
}
