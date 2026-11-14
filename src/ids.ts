type Brand<K extends string> = string & { readonly __brand: K };

export type SessionId = Brand<"SessionId">;
export type WindowId = Brand<"WindowId">;
export type BlockId = Brand<"BlockId">;
export type ClientId = Brand<"ClientId">;

function parser<T extends string>(prefix: string): (raw: unknown) => T {
  return (raw) => {
    if (typeof raw !== "string" || !raw.startsWith(prefix)) {
      throw new Error(`expected a ${prefix} ID, got ${JSON.stringify(raw)}`);
    }
    return raw as T;
  };
}

export const parseSessionId = parser<SessionId>("session:");
export const parseWindowId = parser<WindowId>("window:");
export const parseBlockId = parser<BlockId>("block:");
export const parseClientId = parser<ClientId>("client:");
