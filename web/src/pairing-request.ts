import { pairingApi } from "@remote/client/pairing-request";

export {
  PairingRequestError,
  pairingDelay,
} from "@remote/client/pairing-request";
export const pairingTime = () => pairingApi(location.origin).time();
export const pairingRequest = (
  ...args: Parameters<ReturnType<typeof pairingApi>["request"]>
) => pairingApi(location.origin).request(...args);
