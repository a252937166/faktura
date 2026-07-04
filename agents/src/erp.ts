import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./store.js";

/**
 * Minimal supplier system-of-record ("ERP") facade.
 *
 * Serves canonical invoice documents at GET /erp/invoices/:number in exactly
 * the shape the FDC Web2Json attestation reads (see docs/erp/*.json). Sources:
 *  - bundled documents committed under docs/erp/ (public via GitHub raw — the
 *    default Web2Json source and the prefix pinned on-chain);
 *  - documents derived from invoices submitted through the intake API, so a
 *    publicly hosted agent can act as its own attestable system of record.
 */

export interface ErpDocument {
  _readme?: string;
  invoice: {
    number: string;
    currency: string;
    amountCents: number;
    issuedAt?: string;
    dueAt?: string;
    dueTs: number;
    supplier?: Record<string, unknown>;
    debtor: { name?: string; tag: string; [k: string]: unknown };
    description?: string;
    document?: string;
    documentSha256: string;
    lineItems?: unknown[];
    history?: Record<string, unknown>;
  };
}

/** Safe filename: ERP docs are keyed by their invoice number. */
const safeName = (n: string) => /^[A-Za-z0-9._-]+$/.test(n);

export function getErpDocument(invoiceNumber: string): ErpDocument | null {
  // 1. bundled system-of-record exports (docs/erp/<number>.json)
  if (safeName(invoiceNumber)) {
    const file = path.join(config.erp.docsDir, `${invoiceNumber}.json`);
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as ErpDocument;
    } catch {
      /* fall through */
    }
  }

  // 2. invoices that entered through the intake API
  const record = db.invoices.find((r) => r.intake.invoiceNumber === invoiceNumber);
  if (!record) return null;
  const i = record.intake;
  return {
    invoice: {
      number: i.invoiceNumber,
      currency: "USD",
      amountCents: Math.round(i.amountUsd * 100),
      dueAt: new Date(i.dueTs).toISOString(),
      dueTs: Math.floor(i.dueTs / 1000),
      supplier: { name: i.supplierName },
      debtor: { name: i.debtorName, tag: i.debtorTag },
      description: i.description,
      documentSha256: i.docHash,
      history: i.history ? { note: i.history } : undefined,
    },
  };
}

export function listErpDocuments(): string[] {
  let bundled: string[] = [];
  try {
    bundled = fs
      .readdirSync(config.erp.docsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    /* no bundled docs */
  }
  const fromIntakes = db.invoices.map((r) => r.intake.invoiceNumber);
  return [...new Set([...bundled, ...fromIntakes])];
}
