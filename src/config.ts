export const QUALITY_THRESHOLD = 75;
export const MAX_EVALUATIONS_PER_PREPARATION = 20;
export const MAX_RESERVES = 9;
export const MAX_RECENT_IDS = 30;
export const STATE_KEY = "service-state:v2";
export const PREPARE_CRON = "45 11,23 * * *";
export const PROMOTE_CRON = "0 0 * * *";
export const WORDPRESS_ENDPOINT =
  "https://wordpress.org/photos/wp-json/wp/v2/photos";
export const WORDPRESS_LANDSCAPE_ORIENTATION_ID = 23;
export const COMMONS_ENDPOINT = "https://commons.wikimedia.org/w/api.php";
export const OUTBOUND_USER_AGENT =
  "cattle-pic/1.0 (daily open cattle photo service; metadata at /today.json)";
export const PROVIDER_SEARCH_TERMS = [
  "cattle pasture",
  "cows grazing",
  "cow meadow",
  "livestock grassland",
  "bovinae pasture",
] as const;
