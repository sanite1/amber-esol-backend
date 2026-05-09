import puppeteer, { Browser } from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import ApiError from "../errors/apiError";
import logger from "../config/logger";

/**
 * Resolves a Chromium executable path that works on both Vercel/Lambda
 * (via @sparticuz/chromium) and local development (via system Chrome).
 *
 * Set CHROME_EXECUTABLE_PATH locally to point at your installed Chrome:
 *   macOS: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
 *   Linux: /usr/bin/google-chrome
 */
const resolveExecutablePath = async (): Promise<string> => {
  // 1. Explicit override (useful for local dev)
  const override = process.env.CHROME_EXECUTABLE_PATH;
  if (override) return override;

  // 2. Vercel / serverless — use the bundled chromium binary
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return await chromium.executablePath();
  }

  // 3. Local dev fallbacks (macOS first, then Linux)
  const macPath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const linuxPath = "/usr/bin/google-chrome";
  const platform = process.platform;
  if (platform === "darwin") return macPath;
  if (platform === "linux") return linuxPath;

  // 4. Last-ditch: try the bundled chromium even locally
  return await chromium.executablePath();
};

/**
 * Generate a PDF buffer from an HTML string.
 * Caller is responsible for setting Content-Type and Content-Disposition headers.
 */
export const generatePdfFromHtml = async (
  html: string,
  options?: { format?: "A4" | "Letter"; landscape?: boolean }
): Promise<Buffer> => {
  let browser: Browser | null = null;

  try {
    const isServerless =
      Boolean(process.env.VERCEL) ||
      Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

    browser = await puppeteer.launch({
      args: isServerless ? chromium.args : ["--no-sandbox"],
      executablePath: await resolveExecutablePath(),
      headless: true,
    });

    const page = await browser.newPage();
    // `domcontentloaded` is sufficient for self-contained HTML templates
    // (no external network requests). `networkidle0` would hang waiting for
    // traffic that never starts.
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const pdf = await page.pdf({
      format: options?.format ?? "A4",
      landscape: options?.landscape ?? false,
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });

    return Buffer.from(pdf);
  } catch (err) {
    logger.error({ err }, "PDF generation failed");
    throw new ApiError(
      500,
      "Could not generate PDF. Please ensure Chrome is installed locally or that the deployment supports Chromium."
    );
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
};
