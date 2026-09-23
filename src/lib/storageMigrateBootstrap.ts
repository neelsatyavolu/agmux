/** Side-effect import: run before any store module reads localStorage. */
import { migrateLegacyStorageKeys } from "./storageMigrate";

migrateLegacyStorageKeys();
