import { IOrgInvoice } from "../../interfaces/orgInvoice.interface";

const formatCurrency = (amount: number, currency = "GBP"): string => {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
  }).format(amount);
};

const formatDate = (d?: Date | null): string => {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export interface InvoiceTemplateData {
  invoice: IOrgInvoice & {
    orgId: any;
  };
  providerName?: string;
  providerAddress?: string;
  providerEmail?: string;
}

export const buildInvoiceHtml = (data: InvoiceTemplateData): string => {
  const inv = data.invoice;
  const org = inv.orgId;
  const orgAddress = org.address
    ? [
        org.address.street,
        org.address.city,
        org.address.postcode,
        org.address.country,
      ]
        .filter(Boolean)
        .join(", ")
    : "";

  const providerName = data.providerName ?? "Amber Training Ltd";
  const providerAddress = data.providerAddress ?? "";
  const providerEmail = data.providerEmail ?? "support@ambertraining.co.uk";

  const lineItemsHtml = inv.lineItems
    .map(
      (item) => `
    <tr>
      <td>${escapeHtml(item.description)}</td>
      <td class="num">${item.quantity}</td>
      <td class="num">${formatCurrency(item.unitPrice, inv.currency)}</td>
      <td class="num">${formatCurrency(item.amount, inv.currency)}</td>
    </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Invoice ${escapeHtml(inv.invoiceNumber)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      margin: 0;
      padding: 48px 56px;
      color: #0B2343;
      font-size: 12px;
      line-height: 1.5;
      background: #ffffff;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding-bottom: 24px;
      border-bottom: 3px solid #0B2343;
    }
    .header .brand h1 {
      margin: 0;
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.5px;
    }
    .header .brand .tag {
      color: #ff7c22;
      font-weight: 600;
      letter-spacing: 1.5px;
      font-size: 10px;
      text-transform: uppercase;
      margin-top: 4px;
    }
    .header .meta {
      text-align: right;
    }
    .header .meta .label {
      font-size: 10px;
      color: rgba(11, 35, 67, 0.5);
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 700;
    }
    .header .meta .invoice-number {
      font-size: 18px;
      font-weight: 800;
      margin-top: 4px;
    }
    .header .meta .status {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-top: 8px;
    }
    .status-issued { background: #fef3c7; color: #92400e; }
    .status-paid { background: #d1fae5; color: #065f46; }
    .status-overdue { background: #fee2e2; color: #991b1b; }
    .status-draft, .status-cancelled { background: #f3f4f6; color: #374151; }
    .parties {
      display: flex;
      gap: 48px;
      padding: 32px 0;
    }
    .party {
      flex: 1;
    }
    .party h3 {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: rgba(11, 35, 67, 0.5);
      margin: 0 0 8px 0;
      font-weight: 700;
    }
    .party .name {
      font-size: 14px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .party .detail {
      color: rgba(11, 35, 67, 0.7);
      margin-bottom: 2px;
    }
    .period {
      background: #fafbfc;
      border: 1px solid rgba(11, 35, 67, 0.06);
      border-radius: 8px;
      padding: 16px 20px;
      margin: 16px 0 32px 0;
      display: flex;
      justify-content: space-between;
    }
    .period .item .label {
      font-size: 9px;
      color: rgba(11, 35, 67, 0.5);
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 700;
    }
    .period .item .value {
      font-weight: 700;
      margin-top: 2px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
    }
    th {
      text-align: left;
      padding: 10px 12px;
      background: #fafbfc;
      border-top: 1px solid rgba(11, 35, 67, 0.1);
      border-bottom: 1px solid rgba(11, 35, 67, 0.1);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: rgba(11, 35, 67, 0.6);
      font-weight: 700;
    }
    th.num, td.num { text-align: right; }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(11, 35, 67, 0.06);
      vertical-align: top;
    }
    .totals {
      margin-left: auto;
      width: 280px;
    }
    .totals .row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
    }
    .totals .row.total {
      font-size: 16px;
      font-weight: 800;
      padding-top: 12px;
      border-top: 2px solid #0B2343;
      margin-top: 8px;
    }
    .totals .label { color: rgba(11, 35, 67, 0.6); }
    .notes {
      margin-top: 40px;
      padding: 16px 20px;
      background: #fafbfc;
      border-left: 3px solid #ff7c22;
      border-radius: 0 8px 8px 0;
      font-size: 11px;
      color: rgba(11, 35, 67, 0.7);
    }
    .notes h4 {
      margin: 0 0 4px 0;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: rgba(11, 35, 67, 0.5);
    }
    .footer {
      margin-top: 56px;
      padding-top: 16px;
      border-top: 1px solid rgba(11, 35, 67, 0.06);
      text-align: center;
      font-size: 10px;
      color: rgba(11, 35, 67, 0.4);
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      <h1>${escapeHtml(providerName)}</h1>
      <div class="tag">ESOL Training Invoice</div>
    </div>
    <div class="meta">
      <div class="label">Invoice Number</div>
      <div class="invoice-number">${escapeHtml(inv.invoiceNumber)}</div>
      <div class="status status-${inv.status}">${escapeHtml(inv.status)}</div>
    </div>
  </div>

  <div class="parties">
    <div class="party">
      <h3>From</h3>
      <div class="name">${escapeHtml(providerName)}</div>
      ${providerAddress ? `<div class="detail">${escapeHtml(providerAddress)}</div>` : ""}
      <div class="detail">${escapeHtml(providerEmail)}</div>
    </div>
    <div class="party">
      <h3>Bill to</h3>
      <div class="name">${escapeHtml(org.name)}</div>
      ${org.contactName ? `<div class="detail">Attn: ${escapeHtml(org.contactName)}</div>` : ""}
      ${orgAddress ? `<div class="detail">${escapeHtml(orgAddress)}</div>` : ""}
      ${org.contactEmail ? `<div class="detail">${escapeHtml(org.contactEmail)}</div>` : ""}
    </div>
  </div>

  <div class="period">
    <div class="item">
      <div class="label">Period start</div>
      <div class="value">${formatDate(inv.periodStart)}</div>
    </div>
    <div class="item">
      <div class="label">Period end</div>
      <div class="value">${formatDate(inv.periodEnd)}</div>
    </div>
    <div class="item">
      <div class="label">Issued</div>
      <div class="value">${formatDate(inv.issuedAt)}</div>
    </div>
    <div class="item">
      <div class="label">Due</div>
      <div class="value">${formatDate(inv.dueAt)}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th class="num">Qty</th>
        <th class="num">Unit price</th>
        <th class="num">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${lineItemsHtml}
    </tbody>
  </table>

  <div class="totals">
    <div class="row">
      <span class="label">Subtotal</span>
      <span>${formatCurrency(inv.subtotal, inv.currency)}</span>
    </div>
    <div class="row">
      <span class="label">VAT (${(inv.vatRate * 100).toFixed(0)}%)</span>
      <span>${formatCurrency(inv.vatAmount, inv.currency)}</span>
    </div>
    <div class="row total">
      <span>Total due</span>
      <span>${formatCurrency(inv.totalAmount, inv.currency)}</span>
    </div>
  </div>

  ${
    inv.notes
      ? `<div class="notes">
    <h4>Notes</h4>
    ${escapeHtml(inv.notes).replace(/\n/g, "<br />")}
  </div>`
      : ""
  }

  <div class="footer">
    Thank you for your business. Please remit payment by ${formatDate(inv.dueAt)}.
  </div>
</body>
</html>`;
};
