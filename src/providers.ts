import type { EligiblePhoto } from "./model";
import { globalPhotoId, type PhotoProviderClient } from "./provider";

const REQUIRED_PROVIDERS = ["wordpress", "commons"] as const;

export class ProviderRegistry {
  readonly providers: readonly PhotoProviderClient[];

  constructor(providers: readonly PhotoProviderClient[]) {
    if (
      providers.length !== REQUIRED_PROVIDERS.length ||
      providers.some(
        (provider, index) => provider.provider !== REQUIRED_PROVIDERS[index],
      )
    ) {
      throw new Error("providers must be ordered as WordPress then Commons");
    }
    this.providers = Object.freeze([...providers]);
  }

  isAvailable(photo: EligiblePhoto): Promise<boolean> {
    const client = this.clientFor(photo);
    return client ? client.isAvailable(photo) : Promise.resolve(false);
  }

  isEligible(photo: EligiblePhoto): Promise<boolean> {
    const client = this.clientFor(photo);
    return client ? client.isEligible(photo) : Promise.resolve(false);
  }

  private clientFor(photo: EligiblePhoto): PhotoProviderClient | undefined {
    if (
      !REQUIRED_PROVIDERS.includes(photo.provider as (typeof REQUIRED_PROVIDERS)[number]) ||
      photo.photoId !== globalPhotoId(photo.provider, photo.providerId)
    ) {
      return undefined;
    }
    return this.providers.find((provider) => provider.provider === photo.provider);
  }
}
