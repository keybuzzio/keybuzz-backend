/**
 * PH15-INBOUND-MESSAGE-NORMALIZATION-01
 * Central message normalization service for all inbound messages
 */

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
  marketplaceLinks?: string[];
  rawPreview?: string;  // First 2-4KB of raw content
}

const PARSER_VERSION = 'v1.0';

// Amazon-specific markers
const AMAZON_MARKERS = {
  messageStart: [
    '------------- Message:',
    '---- Message original ----',
    '--- Message acheteur ---',
    'Message de l\'acheteur :',
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
  // MIME boundaries
  /------=_Part_\d+/g,
  /Content-Type:\s*[^\n]+/gi,
  /Content-Transfer-Encoding:\s*[^\n]+/gi,
  /MIME-Version:\s*[^\n]+/gi,
  /boundary="[^"]+"/gi,
  
  // Amazon legal footers
  /Droits d'auteur[^]*$/i,
  /Important\s*:[^]*ne pas répondre[^]*$/i,
  /Cet e-mail a-t-il été utile\s*\?[^]*$/i,
  /We hope to see you again soon[^]*$/i,
  /Si vous avez des questions[^]*contactez le vendeur[^]*$/i,
  
  // Common email footers
  /---\s*\n\s*Envoyé depuis[^]*$/i,
  /Sent from my iPhone[^]*$/i,
  /Sent from my Android[^]*$/i,
  
  // Tracking links
  /https?:\/\/[^\s]+sellercentral[^\s]+/gi,
  /https?:\/\/[^\s]+amazon[^\s]*\/(gp\/help|hz\/feedback|messaging)[^\s]*/gi,
  
  // Reply markers
  /^>\s*.*$/gm,
  /^On .* wrote:$/gm,
  /^Le .* a écrit :$/gm,
];

// Patterns to extract clean message from Amazon emails
const AMAZON_EXTRACTION_PATTERNS = [
  // Pattern 1: Between markers
  /------------- Message:\s*([\s\S]*?)\s*------------- Fin/i,
  
  // Pattern 2: After "Message de l'acheteur"
  /Message de l'acheteur\s*:\s*([\s\S]*?)(?:\n{2,}|---|\Z)/i,
  
  // Pattern 3: After "Buyer Message:"
  /Buyer Message:\s*([\s\S]*?)(?:\n{2,}|---|\Z)/i,
  
  // Pattern 4: Between "Message original" markers
  /---- Message original ----\s*([\s\S]*?)(?:----|\Z)/i,
];

/**
 * Decode quoted-printable encoding
 */
function decodeQuotedPrintable(text: string): string {
  return text
    // Soft line breaks
    .replace(/=\r?\n/g, '')
    // Hex encoded characters
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => 
      String.fromCharCode(parseInt(hex, 16))
    );
}

/**
 * Convert basic HTML to plain text
 */
function htmlToPlainText(html: string): string {
  return html
    // Remove scripts and styles
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Convert common HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&euro;/gi, '€')
    // Add line breaks for block elements
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    // Remove all remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // Decode remaining entities
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/**
 * Normalize whitespace and clean up text
 */
function normalizeWhitespace(text: string): string {
  return text
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Remove excessive blank lines (keep max 2)
    .replace(/\n{3,}/g, '\n\n')
    // Trim lines
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    // Trim overall
    .trim();
}

/**
 * Extract Amazon message using markers
 */
function extractAmazonMessage(text: string): { extracted: string | null; method: string } {
  // Try each extraction pattern
  for (const pattern of AMAZON_EXTRACTION_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const extracted = match[1].trim();
      if (extracted.length > 5) {
        return { extracted, method: 'amazon_markers' };
      }
    }
  }
  
  // Try finding message between any start/end marker combination
  for (const startMarker of AMAZON_MARKERS.messageStart) {
    const startIdx = text.indexOf(startMarker);
    if (startIdx !== -1) {
      const afterStart = text.substring(startIdx + startMarker.length);
      
      // Look for end marker
      for (const endMarker of AMAZON_MARKERS.messageEnd) {
        const endIdx = afterStart.indexOf(endMarker);
        if (endIdx !== -1) {
          const extracted = afterStart.substring(0, endIdx).trim();
          if (extracted.length > 5) {
            return { extracted, method: 'amazon_markers' };
          }
        }
      }
      
      // No end marker found, take first meaningful paragraph
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

/**
 * Generic cleanup for any message source
 */
function genericCleanup(text: string): string {
  let cleaned = text;
  
  // Apply noise removal patterns
  for (const pattern of NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  
  // Normalize whitespace
  cleaned = normalizeWhitespace(cleaned);
  
  // If still too long, try to get first meaningful paragraphs
  if (cleaned.length > 2000) {
    const paragraphs = cleaned.split(/\n{2,}/);
    const meaningfulParagraphs = paragraphs.filter(p => {
      const trimmed = p.trim();
      // Skip very short paragraphs and those that look like headers/footers
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

/**
 * Extract Amazon order reference
 */
function extractOrderRef(text: string): string | null {
  const patterns = [
    /\b(\d{3}-\d{7}-\d{7})\b/,  // Amazon order ID: 123-1234567-1234567
    /order\s*#?\s*:?\s*(\d{3}-\d{7}-\d{7})/i,
    /commande\s*#?\s*:?\s*(\d{3}-\d{7}-\d{7})/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Extract marketplace links from message
 */
function extractMarketplaceLinks(text: string): string[] {
  const links: string[] = [];
  const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
  const matches = text.match(urlPattern) || [];
  
  for (const url of matches) {
    if (url.includes('amazon') || url.includes('sellercentral')) {
      // Clean up the URL (remove trailing punctuation)
      const cleanUrl = url.replace(/[.,;:!?)\]]+$/, '');
      if (!links.includes(cleanUrl)) {
        links.push(cleanUrl);
      }
    }
  }
  
  return links.slice(0, 5); // Max 5 links
}

/**
 * Determine message source
 */
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

/**
 * Main normalization function
 * Call this before inserting any inbound message into the DB
 */
export function normalizeInboundMessage(input: {
  rawBody: string;
  rawSubject?: string;
  rawFrom?: string;
  rawTo?: string;
  marketplace?: string;
}): NormalizedMessage {
  const { rawBody, rawSubject = '', rawFrom = '', rawTo = '' } = input;
  
  // Step 1: Detect source
  const source = input.marketplace?.toUpperCase() as MessageMetadata['source'] || 
                 detectSource(rawBody, rawFrom);
  
  // Step 2: Decode MIME if needed
  let decoded = rawBody;
  if (decoded.includes('=?') || decoded.includes('=3D') || decoded.includes('=\r\n')) {
    decoded = decodeQuotedPrintable(decoded);
  }
  
  // Step 3: Convert HTML if present
  if (decoded.includes('<html') || decoded.includes('<div') || decoded.includes('<p')) {
    decoded = htmlToPlainText(decoded);
  }
  
  // Step 4: Extract clean message based on source
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
  
  // Step 5: Final cleanup
  cleanBody = normalizeWhitespace(cleanBody);
  
  // Ensure minimum content
  if (cleanBody.length < 3) {
    cleanBody = decoded.substring(0, 500).trim() || '[Message vide]';
    extractionMethod = 'raw';
  }
  
  // Step 6: Generate preview (150 chars max)
  const preview = cleanBody.length > 150 
    ? cleanBody.substring(0, 147) + '...'
    : cleanBody;
  
  // Step 7: Build metadata
  const metadata: MessageMetadata = {
    source,
    extractionMethod,
    parserVersion: PARSER_VERSION,
    rawSubject: rawSubject || undefined,
    rawFrom: rawFrom || undefined,
    rawTo: rawTo || undefined,
    orderRef: extractOrderRef(rawBody) || extractOrderRef(rawSubject) || undefined,
    marketplaceLinks: extractMarketplaceLinks(rawBody),
    rawPreview: rawBody.substring(0, 4000), // Max 4KB
  };
  
  console.log(`[MessageNormalizer] Normalized message: source=${source}, method=${extractionMethod}, cleanLength=${cleanBody.length}`);
  
  return {
    cleanBody,
    preview,
    metadata,
  };
}
