/**
 * Inbound Email Health Checks Service
 * PH11-06B.5C
 */

import { logger } from "../../config/logger";
import dns from "dns/promises";
import https from "https";

export interface HealthCheckResult {
  name: string;
  status: "OK" | "WARNING" | "ERROR" | "NA";
  message: string;
  lastCheckedAt: string;
  details?: any;
}

/**
 * Check DKIM DNS record for inbound domain
 */
export async function checkDKIM(domain: string = "inbound.keybuzz.io"): Promise<HealthCheckResult> {
  try {
    // Check for kbz1._domainkey.inbound.keybuzz.io
    const dkimSelector = "kbz1";
    const dkimDomain = `${dkimSelector}._domainkey.${domain}`;
    
    const records = await dns.resolveTxt(dkimDomain);
    
    if (records && records.length > 0) {
      const dkimRecord = records.flat().join("");
      
      if (dkimRecord.includes("v=DKIM1")) {
        return {
          name: "DKIM Inbound",
          status: "OK",
          message: "DKIM record found and valid",
          lastCheckedAt: new Date().toISOString(),
          details: { selector: dkimSelector, domain: dkimDomain },
        };
      }
    }
    
    return {
      name: "DKIM Inbound",
      status: "WARNING",
      message: "DKIM record found but format invalid",
      lastCheckedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.warn(`[HealthCheck] DKIM check failed: ${(error as Error).message}`);
    return {
      name: "DKIM Inbound",
      status: "ERROR",
      message: `DKIM record not found: ${(error as Error).message}`,
      lastCheckedAt: new Date().toISOString(),
    };
  }
}

/**
 * Check DMARC DNS record
 */
export async function checkDMARC(domain: string = "inbound.keybuzz.io"): Promise<HealthCheckResult> {
  try {
    const dmarcDomain = `_dmarc.${domain}`;
    const records = await dns.resolveTxt(dmarcDomain);
    
    if (records && records.length > 0) {
      const dmarcRecord = records.flat().join("");
      
      if (dmarcRecord.includes("v=DMARC1")) {
        return {
          name: "DMARC",
          status: "OK",
          message: "DMARC policy configured",
          lastCheckedAt: new Date().toISOString(),
          details: { domain: dmarcDomain },
        };
      }
    }
    
    return {
      name: "DMARC",
      status: "WARNING",
      message: "DMARC record found but format invalid",
      lastCheckedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.warn(`[HealthCheck] DMARC check failed: ${(error as Error).message}`);
    return {
      name: "DMARC",
      status: "WARNING",
      message: "DMARC not configured (optional)",
      lastCheckedAt: new Date().toISOString(),
    };
  }
}

/**
 * Check MTA-STS policy
 */
export async function checkMTASTS(domain: string = "inbound.keybuzz.io"): Promise<HealthCheckResult> {
  return new Promise((resolve) => {
    const url = `https://mta-sts.${domain}/.well-known/mta-sts.txt`;
    
    const req = https.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode === 200) {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (data.includes("version: STSv1")) {
            resolve({
              name: "MTA-STS",
              status: "OK",
              message: "MTA-STS policy active",
              lastCheckedAt: new Date().toISOString(),
            });
          } else {
            resolve({
              name: "MTA-STS",
              status: "WARNING",
              message: "MTA-STS policy format invalid",
              lastCheckedAt: new Date().toISOString(),
            });
          }
        });
      } else {
        resolve({
          name: "MTA-STS",
          status: "WARNING",
          message: "MTA-STS not configured (optional)",
          lastCheckedAt: new Date().toISOString(),
        });
      }
    });
    
    req.on("error", (error) => {
      logger.warn(`[HealthCheck] MTA-STS check failed: ${error.message}`);
      resolve({
        name: "MTA-STS",
        status: "WARNING",
        message: "MTA-STS not configured (optional)",
        lastCheckedAt: new Date().toISOString(),
      });
    });
    
    req.on("timeout", () => {
      req.destroy();
      resolve({
        name: "MTA-STS",
        status: "WARNING",
        message: "MTA-STS check timeout",
        lastCheckedAt: new Date().toISOString(),
      });
    });
  });
}

/**
 * Check Postfix webhook (last inbound email received)
 */
export async function checkWebhook(connectionId: string): Promise<HealthCheckResult> {
  try {
    const { prisma } = await import("../../lib/db");
    
    // Get last inbound email for this connection
    const lastAddress = await prisma.inboundAddress.findFirst({
      where: { connectionId },
      orderBy: { lastInboundAt: "desc" },
    });
    
    if (!lastAddress || !lastAddress.lastInboundAt) {
      return {
        name: "Webhook",
        status: "WARNING",
        message: "Check if any address has lastInboundAt",
        lastCheckedAt: new Date().toISOString(),
      };
    }
    
    const hoursSinceLastEmail = (Date.now() - lastAddress.lastInboundAt.getTime()) / (1000 * 60 * 60);
    
    if (hoursSinceLastEmail < 24) {
      return {
        name: "Webhook",
        status: "OK",
        message: `Last email received ${Math.round(hoursSinceLastEmail)}h ago`,
        lastCheckedAt: new Date().toISOString(),
        details: { lastInboundAt: lastAddress.lastInboundAt },
      };
    } else if (hoursSinceLastEmail < 72) {
      return {
        name: "Webhook",
        status: "WARNING",
        message: `Last email received ${Math.round(hoursSinceLastEmail)}h ago`,
        lastCheckedAt: new Date().toISOString(),
      };
    } else {
      return {
        name: "Webhook",
        status: "ERROR",
        message: `No email received for ${Math.round(hoursSinceLastEmail)}h`,
        lastCheckedAt: new Date().toISOString(),
      };
    }
  } catch (error) {
    logger.error(`[HealthCheck] Webhook check failed: ${(error as Error).message}`);
    return {
      name: "Webhook",
      status: "ERROR",
      message: `Webhook check error: ${(error as Error).message}`,
      lastCheckedAt: new Date().toISOString(),
    };
  }
}

/**
 * Check Backend API health
 */
export async function checkBackendAPI(): Promise<HealthCheckResult> {
  try {
    const { prisma } = await import("../../lib/db");
    
    // Simple DB ping
    await prisma.$queryRaw`SELECT 1`;
    
    return {
      name: "Backend",
      status: "OK",
      message: "API and database responding",
      lastCheckedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`[HealthCheck] Backend API check failed: ${(error as Error).message}`);
    return {
      name: "Backend",
      status: "ERROR",
      message: `Backend API error: ${(error as Error).message}`,
      lastCheckedAt: new Date().toISOString(),
    };
  }
}

/**
 * Check Amazon polling status
 */
export async function checkAmazonPolling(tenantId: string): Promise<HealthCheckResult> {
  try {
    const { prisma } = await import("../../lib/db");    
    // Check if Amazon OAuth is connected
    const amazonMarketplace = await prisma.marketplaceConnection.findFirst({
      where: {
        tenantId,
        type: "AMAZON",
        status: "CONNECTED",
      },
    });
    
    if (!amazonMarketplace) {
      return {
        name: "Amazon Polling",
        status: "NA",
        message: "Amazon polling not enabled (OAuth not connected)",
        lastCheckedAt: new Date().toISOString(),
      };
    }

    // Get last AMAZON_POLL job for tenant
    const lastJob = await prisma.job.findFirst({
      where: {
        tenantId,
        type: "AMAZON_POLL",
      },
      orderBy: { createdAt: "desc" },
    });
    
    if (!lastJob) {
      return {
        name: "Amazon Polling",
        status: "WARNING",
        message: "No polling jobs found yet",
        lastCheckedAt: new Date().toISOString(),
      };
    }
    
    if (lastJob.status === "DONE") {
      const hoursSinceLastJob = (Date.now() - lastJob.updatedAt.getTime()) / (1000 * 60 * 60);
      
      if (hoursSinceLastJob < 1) {
        return {
          name: "Amazon Polling",
          status: "OK",
          message: `Last poll ${Math.round(hoursSinceLastJob * 60)}min ago`,
          lastCheckedAt: new Date().toISOString(),
        };
      } else {
        return {
          name: "Amazon Polling",
          status: "WARNING",
          message: `Last poll ${Math.round(hoursSinceLastJob)}h ago`,
          lastCheckedAt: new Date().toISOString(),
        };
      }
    } else if (lastJob.status === "FAILED") {
      return {
        name: "Amazon Polling",
        status: "ERROR",
        message: `Last poll failed: ${lastJob.lastError || "Unknown error"}`,
        lastCheckedAt: new Date().toISOString(),
      };
    } else {
      return {
        name: "Amazon Polling",
        status: "WARNING",
        message: `Last poll status: ${lastJob.status}`,
        lastCheckedAt: new Date().toISOString(),
      };
    }
  } catch (error) {
    logger.error(`[HealthCheck] Amazon polling check failed: ${(error as Error).message}`);
    return {
      name: "Amazon Polling",
      status: "ERROR",
      message: `Polling check error: ${(error as Error).message}`,
      lastCheckedAt: new Date().toISOString(),
    };
  }
}

/**
 * Get all health checks for a connection
 */
export async function getAllHealthChecks(connectionId: string, tenantId: string): Promise<HealthCheckResult[]> {
  const [dkim, dmarc, mtasts, webhook, backend, amazonPolling] = await Promise.all([
    checkDKIM(),
    checkDMARC(),
    checkMTASTS(),
    checkWebhook(connectionId),
    checkBackendAPI(),
    checkAmazonPolling(tenantId),
  ]);
  
  return [dkim, dmarc, mtasts, webhook, backend, amazonPolling];
}
