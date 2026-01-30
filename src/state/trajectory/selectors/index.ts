import { createSelector } from "reselect";

import {
    isNetworkSimFileInterface,
    isLocalFileInterface,
    LocalSimFile,
    NetworkedSimFile,
} from "../types";
import { getSimulariumFile } from "./basic";

export const getIsNetworkedFile = createSelector(
    [getSimulariumFile],
    (simFile: LocalSimFile | NetworkedSimFile): boolean => {
        if (!simFile.name) {
            return false;
        }
        return isNetworkSimFileInterface(simFile);
    }
);

export const getIsUsdFile = createSelector(
    [getSimulariumFile],
    (simFile: LocalSimFile | NetworkedSimFile): boolean => {
        if (!simFile.name) {
            return false;
        }
        if (isLocalFileInterface(simFile)) {
            return !!simFile.usdData;
        }
        return false;
    }
);

export * from "./basic";
