import { MARKETPLACE_UNAVAILABLE } from "./extensionModel";

/**
 * The online extension marketplace: not built. This only answers that honestly, so the view can say
 * so instead of showing a search box that does nothing.
 */
export class ExtensionMarketplaceService {
  readonly available = false;
  readonly message = MARKETPLACE_UNAVAILABLE;
}
