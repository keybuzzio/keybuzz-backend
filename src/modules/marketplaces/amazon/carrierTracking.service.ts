// src/modules/marketplaces/amazon/carrierTracking.service.ts
// PH15-TRACKING-REAL-01: Carrier normalization and tracking URL generation

interface CarrierConfig {
  name: string;
  displayName: string;
  trackingUrlTemplate: string;
}

// Mapping of carrier names (case-insensitive contains match)
const CARRIER_MAPPINGS: { pattern: string; config: CarrierConfig }[] = [
  // Amazon
  { pattern: "amzn_", config: { name: "AMAZON", displayName: "Amazon Logistics", trackingUrlTemplate: "https://track.amazon.fr/tracking/{tracking}" } },
  { pattern: "amazon", config: { name: "AMAZON", displayName: "Amazon Logistics", trackingUrlTemplate: "https://track.amazon.fr/tracking/{tracking}" } },
  
  // La Poste / Colissimo
  { pattern: "colissimo", config: { name: "COLISSIMO", displayName: "Colissimo", trackingUrlTemplate: "https://www.laposte.fr/outils/suivre-vos-envois?code={tracking}" } },
  { pattern: "la poste", config: { name: "COLISSIMO", displayName: "La Poste", trackingUrlTemplate: "https://www.laposte.fr/outils/suivre-vos-envois?code={tracking}" } },
  { pattern: "laposte", config: { name: "COLISSIMO", displayName: "La Poste", trackingUrlTemplate: "https://www.laposte.fr/outils/suivre-vos-envois?code={tracking}" } },
  
  // Chronopost
  { pattern: "chronopost", config: { name: "CHRONOPOST", displayName: "Chronopost", trackingUrlTemplate: "https://www.chronopost.fr/tracking-no-cms/suivi-page?liession={tracking}" } },
  
  // DPD
  { pattern: "dpd", config: { name: "DPD", displayName: "DPD", trackingUrlTemplate: "https://www.dpd.fr/trace/{tracking}" } },
  
  // UPS
  { pattern: "ups", config: { name: "UPS", displayName: "UPS", trackingUrlTemplate: "https://www.ups.com/track?tracknum={tracking}" } },
  
  // FedEx
  { pattern: "fedex", config: { name: "FEDEX", displayName: "FedEx", trackingUrlTemplate: "https://www.fedex.com/fedextrack/?trknbr={tracking}" } },
  
  // DHL
  { pattern: "dhl", config: { name: "DHL", displayName: "DHL", trackingUrlTemplate: "https://www.dhl.com/fr-fr/home/tracking.html?tracking-id={tracking}" } },
  
  // Mondial Relay
  { pattern: "mondial relay", config: { name: "MONDIAL_RELAY", displayName: "Mondial Relay", trackingUrlTemplate: "https://www.mondialrelay.fr/suivi-de-colis/?NumColis={tracking}" } },
  { pattern: "mondialrelay", config: { name: "MONDIAL_RELAY", displayName: "Mondial Relay", trackingUrlTemplate: "https://www.mondialrelay.fr/suivi-de-colis/?NumColis={tracking}" } },
  { pattern: "relay", config: { name: "MONDIAL_RELAY", displayName: "Mondial Relay", trackingUrlTemplate: "https://www.mondialrelay.fr/suivi-de-colis/?NumColis={tracking}" } },
  
  // GLS
  { pattern: "gls", config: { name: "GLS", displayName: "GLS", trackingUrlTemplate: "https://gls-group.eu/FR/fr/suivi-colis?match={tracking}" } },
  
  // TNT
  { pattern: "tnt", config: { name: "TNT", displayName: "TNT", trackingUrlTemplate: "https://www.tnt.com/express/fr_fr/site/shipping-tools/tracking.html?searchType=con&cons={tracking}" } },
  
  // Colis Prive
  { pattern: "colis prive", config: { name: "COLIS_PRIVE", displayName: "Colis Prive", trackingUrlTemplate: "https://www.colisprive.com/moncolis/pages/detailColis.aspx?numColis={tracking}" } },
  { pattern: "colisprive", config: { name: "COLIS_PRIVE", displayName: "Colis Prive", trackingUrlTemplate: "https://www.colisprive.com/moncolis/pages/detailColis.aspx?numColis={tracking}" } },
  
  // Hermes
  { pattern: "hermes", config: { name: "HERMES", displayName: "Hermes", trackingUrlTemplate: "https://www.myhermes.co.uk/track#/{tracking}" } },
  
  // Royal Mail (UK)
  { pattern: "royal mail", config: { name: "ROYAL_MAIL", displayName: "Royal Mail", trackingUrlTemplate: "https://www.royalmail.com/track-your-item#{tracking}" } },
  { pattern: "royalmail", config: { name: "ROYAL_MAIL", displayName: "Royal Mail", trackingUrlTemplate: "https://www.royalmail.com/track-your-item#{tracking}" } },
  
  // USPS (US)
  { pattern: "usps", config: { name: "USPS", displayName: "USPS", trackingUrlTemplate: "https://tools.usps.com/go/TrackConfirmAction?tLabels={tracking}" } },
  
  // Poste Italiane
  { pattern: "poste italian", config: { name: "POSTE_ITALIANE", displayName: "Poste Italiane", trackingUrlTemplate: "https://www.poste.it/cerca/index.html#/risultati-spedizioni/{tracking}" } },
  { pattern: "sda", config: { name: "SDA", displayName: "SDA", trackingUrlTemplate: "https://www.sda.it/wps/portal/Servizi_online/ricerca_spedizioni?locale=it&tression={tracking}" } },
  
  // Deutsche Post / DHL DE
  { pattern: "deutsche post", config: { name: "DEUTSCHE_POST", displayName: "Deutsche Post", trackingUrlTemplate: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode={tracking}" } },
  
  // Correos (Spain)
  { pattern: "correos", config: { name: "CORREOS", displayName: "Correos", trackingUrlTemplate: "https://www.correos.es/ss/Satellite/site/aplicacion-localizador_702/sidioma=es_ES?numero={tracking}" } },
  
  // PostNL (Netherlands)
  { pattern: "postnl", config: { name: "POSTNL", displayName: "PostNL", trackingUrlTemplate: "https://postnl.nl/tracktrace/?L=NL&B={tracking}&P=&D=&T=C" } },
  
  // Bpost (Belgium)
  { pattern: "bpost", config: { name: "BPOST", displayName: "bpost", trackingUrlTemplate: "https://track.bpost.cloud/btr/web/#/search?itemCode={tracking}&lang=fr" } },
];

// Fallback URL (17track international)
const FALLBACK_URL_TEMPLATE = "https://www.17track.net/fr?nums={tracking}";

/**
 * Normalize carrier name from raw Amazon carrier string
 */
export function normalizeCarrierName(rawCarrier: string | null | undefined): { name: string; displayName: string } | null {
  if (!rawCarrier) return null;
  
  const lowerCarrier = rawCarrier.toLowerCase().trim();
  
  for (const mapping of CARRIER_MAPPINGS) {
    if (lowerCarrier.includes(mapping.pattern)) {
      return { name: mapping.config.name, displayName: mapping.config.displayName };
    }
  }
  
  // Unknown carrier - use raw name as display
  return { name: "OTHER", displayName: rawCarrier };
}

/**
 * Build tracking URL for a carrier and tracking number
 */
export function buildTrackingUrl(rawCarrier: string | null | undefined, trackingNumber: string | null | undefined): string | null {
  if (!trackingNumber) return null;
  
  const lowerCarrier = (rawCarrier || "").toLowerCase().trim();
  
  for (const mapping of CARRIER_MAPPINGS) {
    if (lowerCarrier.includes(mapping.pattern)) {
      return mapping.config.trackingUrlTemplate.replace("{tracking}", encodeURIComponent(trackingNumber));
    }
  }
  
  // Fallback to 17track
  return FALLBACK_URL_TEMPLATE.replace("{tracking}", encodeURIComponent(trackingNumber));
}

/**
 * Get full tracking info for an order
 */
export function getTrackingInfo(rawCarrier: string | null | undefined, trackingNumber: string | null | undefined): {
  carrier: string | null;
  carrierDisplayName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
} {
  const normalized = normalizeCarrierName(rawCarrier);
  const url = buildTrackingUrl(rawCarrier, trackingNumber);
  
  return {
    carrier: normalized?.name || null,
    carrierDisplayName: normalized?.displayName || null,
    trackingNumber: trackingNumber || null,
    trackingUrl: url,
  };
}