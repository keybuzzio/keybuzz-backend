/**
 * PH15-INBOUND-MESSAGE-NORMALIZATION-01 + PH15-AMAZON-THREADING-ENCODING-01 + PH15-AMAZON-IDS
 * Central message normalization service for all inbound messages
 * With encoding fix (mojibake), thread key extraction, and Amazon ID parsing
 */
import { createHash } from 'crypto';

export interface NormalizedMessage {
  cleanBody: string;
  preview: string;
  metadata: MessageMetadata;
}

export interface MessageMetadata {
  source: 'AMAZON' | 'FNAC' | 'CDISCOUNT' | 'EMAIL' | 'OTHER';
  extractionMethod: 'amazon_markers' | 'generic_cleanup' | 'email_cleanup' | 'raw';
  parserVersion: string;
  rawSubject?: string;
  rawFrom?: string;
  rawTo?: string;
  orderRef?: string | null;
  threadKey?: string | null;
  marketplaceLinks?: string[];
  amazonIds?: {
    threadId?: string;
    messageId?: string;
    customerId?: string;
    marketplaceId?: string;
  };
  rawPreview?: string;
  encodingFixed?: boolean;
}

const PARSER_VERSION = 'v1.2';

// Amazon-specific markers
const AMAZON_MARKERS = {
  messageStart: [
    '------------- Message:',
    '---- Message original ----',
    '--- Message acheteur ---',
    "Message de l'acheteur :",
    'Buyer Message:',
    'Message from buyer:',
  ],
  messageEnd: [
    '------------- Fin du message',
    '------------- End of message',
    '---',
  ],
};

// Noise patterns to remove
const NOISE_PATTERNS = [
  /------=_Part_\d+/g,
  /Content-Type:\s*[^\n]+/gi,
  /Content-Transfer-Encoding:\s*[^\n]+/gi,
  /MIME-Version:\s*[^\n]+/gi,
  /boundary="[^"]+"/gi,
  /Droits d'auteur[^]*$/i,
  /Important\s*:[^]*ne pas répondre[^]*$/i,
  /Cet e-mail a-t-il été utile\s*\?[^]*$/i,
  /We hope to see you again soon[^]*$/i,
  /Si vous avez des questions[^]*contactez le vendeur[^]*$/i,
  /---\s*\n\s*Envoyé depuis[^]*$/i,
  /Sent from my iPhone[^]*$/i,
  /Sent from my Android[^]*$/i,
  /https?:\/\/[^\s]+sellercentral[^\s]+/gi,
  /https?:\/\/[^\s]+amazon[^\s]*\/(gp\/help|hz\/feedback|messaging)[^\s]*/gi,
  /^>\s*.*$/gm,
  /^On .* wrote:$/gm,
  /^Le .* a écrit :$/gm,
];

const AMAZON_EXTRACTION_PATTERNS = [
  /------------- Message:\s*([\s\S]*?)\s*------------- Fin/i,
  /Message de l'acheteur\s*:\s*([\s\S]*?)(?:\n{2,}|---|\Z)/i,
  /Buyer Message:\s*([\s\S]*?)(?:\n{2,}|---|\Z)/i,
  /---- Message original ----\s*([\s\S]*?)(?:----|\Z)/i,
];

// =====================================================
// PH15: ENCODING FIX - Mojibake detection and repair
// =====================================================

const MOJIBAKE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\xc3\xa0/g, 'à'], [/\xc3\xa1/g, 'á'], [/\xc3\xa2/g, 'â'],
  [/\xc3\xa3/g, 'ã'], [/\xc3\xa4/g, 'ä'], [/\xc3\xa5/g, 'å'],
  [/\xc3\xa6/g, 'æ'], [/\xc3\xa7/g, 'ç'], [/\xc3\xa8/g, 'è'],
  [/\xc3\xa9/g, 'é'], [/\xc3\xaa/g, 'ê'], [/\xc3\xab/g, 'ë'],
  [/\xc3\xac/g, 'ì'], [/\xc3\xad/g, 'í'], [/\xc3\xae/g, 'î'],
  [/\xc3\xaf/g, 'ï'], [/\xc3\xb0/g, 'ð'], [/\xc3\xb1/g, 'ñ'],
  [/\xc3\xb2/g, 'ò'], [/\xc3\xb3/g, 'ó'], [/\xc3\xb4/g, 'ô'],
  [/\xc3\xb5/g, 'õ'], [/\xc3\xb6/g, 'ö'], [/\xc3\xb8/g, 'ø'],
  [/\xc3\xb9/g, 'ù'], [/\xc3\xba/g, 'ú'], [/\xc3\xbb/g, 'û'],
  [/\xc3\xbc/g, 'ü'], [/\xc3\xbd/g, 'ý'], [/\xc3\xbe/g, 'þ'],
  [/\xc3\xbf/g, 'ÿ'],
  [/Ã /g, 'à'], [/Ã¡/g, 'á'], [/Ã¢/g, 'â'], [/Ã£/g, 'ã'],
  [/Ã¤/g, 'ä'], [/Ã¥/g, 'å'], [/Ã¦/g, 'æ'], [/Ã§/g, 'ç'],
  [/Ã¨/g, 'è'], [/Ã©/g, 'é'], [/Ãª/g, 'ê'], [/Ã«/g, 'ë'],
  [/Ã¬/g, 'ì'], [/Ã­/g, 'í'], [/Ã®/g, 'î'], [/Ã¯/g, 'ï'],
  [/Ã°/g, 'ð'], [/Ã±/g, 'ñ'], [/Ã²/g, 'ò'], [/Ã³/g, 'ó'],
  [/Ã´/g, 'ô'], [/Ãµ/g, 'õ'], [/Ã¶/g, 'ö'], [/Ã¸/g, 'ø'],
  [/Ã¹/g, 'ù'], [/Ãº/g, 'ú'], [/Ã»/g, 'û'], [/Ã¼/g, 'ü'],
  [/Ã½/g, 'ý'], [/Ã¾/g, 'þ'], [/Ã¿/g, 'ÿ'],
  [/â€™/g, "'"], [/â€œ/g, '"'], [/â€/g, '"'],
  [/â€"/g, '–'], [/â€"/g, '—'], [/â€¦/g, '…'],
  [/Â(?=[À-ÿ])/g, ''], [/Â /g, ' '], [/Â$/g, ''],
];

function hasMojibake(text: string): boolean {
  return text.includes('\u00c3') ||
         text.includes('\u00e2\u0080') ||
         (text.includes('\u00c2') && /[^\x00-\x7F]/.test(text));
}

function fixMojibake(text: string): { fixed: string; wasFixed: boolean } {
  if (!hasMojibake(text)) {
    return { fixed: text, wasFixed: false };
  }
  
  let result = text;
  for (const [pattern, replacement] of MOJIBAKE_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  
  return { fixed: result, wasFixed: result !== text };
}

function tryReencodeAsUtf8(text: string): string {
  try {
    if (hasMojibake(text)) {
      const buf = Buffer.from(text, 'latin1');
      const reencoded = buf.toString('utf8');
      if (!hasMojibake(reencoded) && reencoded.length > 0) {
        return reencoded;
      }
    }
  } catch {
    // Ignore errors
  }
  return text;
}

function fixEncoding(text: string): { text: string; fixed: boolean } {
  let result = tryReencodeAsUtf8(text);
  let wasFixed = result !== text;
  
  const { fixed, wasFixed: mapFixed } = fixMojibake(result);
  
  return {
    text: fixed,
    fixed: wasFixed || mapFixed,
  };
}

// =====================================================
// PH15: AMAZON ID EXTRACTION
// =====================================================

/**
 * Extract all Amazon IDs from message body URLs
 * Decodes quoted-printable URLs like =3D -> =
 */
function extractAmazonIds(rawBody: string): MessageMetadata['amazonIds'] {
  const result: MessageMetadata['amazonIds'] = {};
  
  // Decode quoted-printable in URLs
  const decodeQP = (str: string): string => {
    return str
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  };
  
  const decodedBody = decodeQP(rawBody);
  
  // Extract t= (thread ID)
  const threadMatch = decodedBody.match(/[?&]t=([A-Z0-9]+)/i);
  if (threadMatch) {
    result.threadId = threadMatch[1];
  }
  
  // Extract m= (message ID)
  const messageMatch = decodedBody.match(/[?&]m=([A-Z0-9]+)/i);
  if (messageMatch) {
    result.messageId = messageMatch[1];
  }
  
  // Extract c= (customer/case ID)
  const customerMatch = decodedBody.match(/[?&]c=([A-Z0-9]+)/i);
  if (customerMatch) {
    result.customerId = customerMatch[1];
  }
  
  // Extract mp= (marketplace ID)
  const marketplaceMatch = decodedBody.match(/[?&]mp=([A-Z0-9]+)/i);
  if (marketplaceMatch) {
    result.marketplaceId = marketplaceMatch[1];
  }
  
  return Object.keys(result).length > 0 ? result : undefined;
}

// =====================================================
// PH15: THREAD KEY EXTRACTION
// =====================================================

function extractAmazonThreadKey(input: {
  rawBody: string;
  rawSubject?: string;
  rawFrom?: string;
  headers?: Record<string, string>;
  marketplaceLinks?: string[];
  amazonIds?: MessageMetadata['amazonIds'];
  orderRef?: string | null;
}): string | null {
  const { rawBody, rawSubject = '', rawFrom = '', headers = {}, marketplaceLinks = [], amazonIds, orderRef } = input;
  
  // A) Use threadId from amazonIds if available
  if (amazonIds?.threadId) {
    return 'sc:' + amazonIds.threadId;
  }
  
  // B) Check headers for thread/case IDs
  const headerKeys = Object.keys(headers).map(k => k.toLowerCase());
  for (const key of headerKeys) {
    if (key.includes('thread') || key.includes('case') || key.includes('conversation')) {
      const value = headers[key];
      if (value && value.length > 3) {
        return 'header:' + value;
      }
    }
  }
  
  // C) Extract from Seller Central URLs
  for (const url of marketplaceLinks) {
    try {
      const urlMatch = url.match(/[?&]t=([^&]+)/);
      if (urlMatch) {
        return 'sc:' + urlMatch[1];
      }
      
      const pathMatch = url.match(/\/messaging\/thread\/([^/?]+)/);
      if (pathMatch) {
        return 'sc:' + pathMatch[1];
      }
      
      const caseMatch = url.match(/case[_-]?id[=:]([^&\s]+)/i);
      if (caseMatch) {
        return 'case:' + caseMatch[1];
      }
    } catch {
      // Ignore URL parsing errors
    }
  }
  
  // D) Also search in body for URLs (with QP decoding)
  const decodedBody = rawBody
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  
  const urlPattern = /https?:\/\/[^\s<>"]+/gi;
  const bodyUrls = decodedBody.match(urlPattern) || [];
  for (const url of bodyUrls) {
    if (url.includes('sellercentral') || url.includes('amazon')) {
      const tMatch = url.match(/[?&]t=([^&]+)/);
      if (tMatch) {
        return 'sc:' + tMatch[1];
      }
    }
  }
  
  // E) Fallback to orderRef
  if (orderRef) {
    return 'order:' + orderRef;
  }
  
  // F) Hash-based fallback
  const normalizedFrom = rawFrom.toLowerCase().replace(/[^a-z0-9@]/g, '');
  const subjectCore = rawSubject.toLowerCase()
    .replace(/^(re:|fwd?:|tr:|aw:)\s*/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 50);
  
  if (subjectCore.length > 5) {
    const hash = createHash('md5')
      .update(normalizedFrom + ':' + subjectCore)
      .digest('hex')
      .substring(0, 12);
    return 'hash:' + hash;
  }
  
  return null;
}

// =====================================================
// EXISTING FUNCTIONS (unchanged)
// =====================================================

function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => 
      String.fromCharCode(parseInt(hex, 16))
    );
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&euro;/gi, '€')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .trim();
}

function extractAmazonMessage(text: string): { extracted: string | null; method: string } {
  for (const pattern of AMAZON_EXTRACTION_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const extracted = match[1].trim();
      if (extracted.length > 5) {
        return { extracted, method: 'amazon_markers' };
      }
    }
  }
  
  for (const startMarker of AMAZON_MARKERS.messageStart) {
    const startIdx = text.indexOf(startMarker);
    if (startIdx !== -1) {
      const afterStart = text.substring(startIdx + startMarker.length);
      
      for (const endMarker of AMAZON_MARKERS.messageEnd) {
        const endIdx = afterStart.indexOf(endMarker);
        if (endIdx !== -1) {
          const extracted = afterStart.substring(0, endIdx).trim();
          if (extracted.length > 5) {
            return { extracted, method: 'amazon_markers' };
          }
        }
      }
      
      const paragraphs = afterStart.split(/\n{2,}/);
      if (paragraphs.length > 0) {
        const firstPara = paragraphs[0].trim();
        if (firstPara.length > 5) {
          return { extracted: firstPara, method: 'amazon_markers' };
        }
      }
    }
  }
  
  return { extracted: null, method: 'none' };
}

function genericCleanup(text: string): string {
  let cleaned = text;
  
  for (const pattern of NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  
  cleaned = normalizeWhitespace(cleaned);
  
  if (cleaned.length > 2000) {
    const paragraphs = cleaned.split(/\n{2,}/);
    const meaningfulParagraphs = paragraphs.filter(p => {
      const trimmed = p.trim();
      return trimmed.length > 20 && 
             !trimmed.match(/^(important|attention|warning|note):/i) &&
             !trimmed.match(/droits d'auteur|copyright/i);
    });
    
    if (meaningfulParagraphs.length > 0) {
      cleaned = meaningfulParagraphs.slice(0, 3).join('\n\n');
    }
  }
  
  return cleaned;
}

function extractOrderRef(text: string): string | null {
  const patterns = [
    /\b(\d{3}-\d{7}-\d{7})\b/,
    /order\s*#?\s*:?\s*(\d{3}-\d{7}-\d{7})/i,
    /commande\s*#?\s*:?\s*(\d{3}-\d{7}-\d{7})/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractMarketplaceLinks(text: string): string[] {
  const links: string[] = [];
  const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
  const matches = text.match(urlPattern) || [];
  
  for (const url of matches) {
    if (url.includes('amazon') || url.includes('sellercentral')) {
      const cleanUrl = url.replace(/[.,;:!?)\]]+$/, '');
      if (!links.includes(cleanUrl)) {
        links.push(cleanUrl);
      }
    }
  }
  
  return links.slice(0, 5);
}

function detectSource(rawBody: string, rawFrom: string): MessageMetadata['source'] {
  const fromLower = rawFrom.toLowerCase();
  const bodyLower = rawBody.toLowerCase();
  
  if (fromLower.includes('@amazon') || 
      fromLower.includes('marketplace.amazon') ||
      bodyLower.includes('amazon') && bodyLower.includes('seller')) {
    return 'AMAZON';
  }
  if (fromLower.includes('@fnac') || bodyLower.includes('fnac')) {
    return 'FNAC';
  }
  if (fromLower.includes('@cdiscount') || bodyLower.includes('cdiscount')) {
    return 'CDISCOUNT';
  }
  
  return 'EMAIL';
}

// =====================================================
// MAIN NORMALIZATION FUNCTION
// =====================================================

export function normalizeInboundMessage(input: {
  rawBody: string;
  rawSubject?: string;
  rawFrom?: string;
  rawTo?: string;
  marketplace?: string;
  headers?: Record<string, string>;
}): NormalizedMessage {
  const { rawBody, rawSubject = '', rawFrom = '', rawTo = '', headers = {} } = input;
  
  const source = input.marketplace?.toUpperCase() as MessageMetadata['source'] || 
                 detectSource(rawBody, rawFrom);
  
  let decoded = rawBody;
  if (decoded.includes('=?') || decoded.includes('=3D') || decoded.includes('=\r\n')) {
    decoded = decodeQuotedPrintable(decoded);
  }
  
  // FIX ENCODING (PH15)
  const { text: encodingFixed, fixed: wasEncodingFixed } = fixEncoding(decoded);
  decoded = encodingFixed;
  
  if (decoded.includes('<html') || decoded.includes('<div') || decoded.includes('<p')) {
    decoded = htmlToPlainText(decoded);
  }
  
  let cleanBody: string;
  let extractionMethod: MessageMetadata['extractionMethod'] = 'generic_cleanup';
  
  if (source === 'AMAZON') {
    const { extracted, method } = extractAmazonMessage(decoded);
    if (extracted) {
      cleanBody = extracted;
      extractionMethod = 'amazon_markers';
    } else {
      cleanBody = genericCleanup(decoded);
      extractionMethod = 'generic_cleanup';
    }
  } else {
    cleanBody = genericCleanup(decoded);
    extractionMethod = source === 'EMAIL' ? 'email_cleanup' : 'generic_cleanup';
  }
  
  cleanBody = normalizeWhitespace(cleanBody);
  const { text: finalClean, fixed: cleanFixed } = fixEncoding(cleanBody);
  cleanBody = finalClean;
  
  if (cleanBody.length < 3) {
    cleanBody = decoded.substring(0, 500).trim() || '[Message vide]';
    extractionMethod = 'raw';
  }
  
  const preview = cleanBody.length > 150 
    ? cleanBody.substring(0, 147) + '...'
    : cleanBody;
  
  const orderRef = extractOrderRef(rawBody) || extractOrderRef(rawSubject) || null;
  const marketplaceLinks = extractMarketplaceLinks(rawBody);
  
  // PH15: Extract Amazon IDs from URLs
  const amazonIds = source === 'AMAZON' ? extractAmazonIds(rawBody) : undefined;
  
  // Extract thread key (PH15)
  const threadKey = source === 'AMAZON' 
    ? extractAmazonThreadKey({
        rawBody,
        rawSubject,
        rawFrom,
        headers,
        marketplaceLinks,
        amazonIds,
        orderRef,
      })
    : null;
  
  const metadata: MessageMetadata = {
    source,
    extractionMethod,
    parserVersion: PARSER_VERSION,
    rawSubject: rawSubject || undefined,
    rawFrom: rawFrom || undefined,
    rawTo: rawTo || undefined,
    orderRef,
    threadKey,
    marketplaceLinks,
    amazonIds,
    rawPreview: rawBody.substring(0, 4000),
    encodingFixed: wasEncodingFixed || cleanFixed,
  };
  
  console.log('[MessageNormalizer] source=' + source + ', method=' + extractionMethod + ', threadKey=' + threadKey + ', amazonIds=' + JSON.stringify(amazonIds) + ', encodingFixed=' + metadata.encodingFixed);
  
  return {
    cleanBody,
    preview,
    metadata,
  };
}
