import {
  encryptedCheck as check,
  openEncryptedSession as open,
  prepareConnection as prepare,
  type RelayOptions,
} from "@remote/client/relay";

export type { PreparedConnection } from "@remote/client/relay";

const options = (): RelayOptions => ({
  origin: location.origin,
  onAccess: (grant, access) => {
    void import("./store.js")
      .then((store) => store.setPhoneAccess(grant, access))
      .catch(() => {});
  },
});
export const openEncryptedSession = (
  ...args: Parameters<typeof open> extends [unknown, ...infer Rest]
    ? Rest
    : never
) => open(options(), ...args);
export const encryptedCheck = (
  ...args: Parameters<typeof check> extends [unknown, ...infer Rest]
    ? Rest
    : never
) => check(options(), ...args);
export const prepareConnection = (
  ...args: Parameters<typeof prepare> extends [unknown, ...infer Rest]
    ? Rest
    : never
) => prepare(options(), ...args);
