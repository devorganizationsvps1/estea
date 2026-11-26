import { COMPANY } from "./company"
import {
  EMAIL_STYLES,
  emailLayout,
  escapeHtml,
  formatMoney,
} from "./format"

export type ReturnEmailLine = {
  title: string
  quantity: number
  reasonLabel?: string | null
  variantLabel?: string | null
}

export type ReturnRequestedCustomerData = {
  returnId: string
  orderDisplayId: string
  email: string
  items: ReturnEmailLine[]
  customerNote?: string | null
  /** Kargo firması iade etiketi — varsa manuel adres yerine etiket/takip talimatı */
  trackingNumber?: string | null
  trackingUrl?: string | null
  labelUrl?: string | null
  carrierCode?: string | null
  /**
   * Etiket/kod yokken akış: "code" = kargo firması iade kodu ayrıca gelecek
   * (adaptörlü kargo), "address" = müşteri ürünü firma adresine kendi kargolar
   * (elle kargo, K1). Varsayılan "code".
   */
  mode?: "code" | "address"
}

export type ReturnRequestedSellerData = {
  returnId: string
  orderDisplayId: string
  orderId: string
  customerEmail: string
  customerName?: string | null
  items: ReturnEmailLine[]
  customerNote?: string | null
  source?: string | null
  trackingNumber?: string | null
  trackingUrl?: string | null
  labelUrl?: string | null
  carrierCode?: string | null
}

export type ReturnRefundedCustomerData = {
  returnId: string
  orderDisplayId: string
  email: string
  amount: number | string
  currencyCode?: string
  shippingIncluded?: boolean
  /** Ürün bazlı kabulde kabul edilmeyen ürünler — para iadesine dahil değil */
  notAccepted?: ReturnEmailLine[]
  notAcceptedReason?: string | null
  /** Kabul edilmeyen ürünlerin inceleme fotoğrafları */
  notAcceptedPhotos?: { url: string }[]
}

export type ReturnRejectedCustomerData = {
  returnId: string
  orderDisplayId: string
  email: string
  reason?: string | null
  items: ReturnEmailLine[]
  /**
   * "before_arrival": paket gelmeden ret (göndermeyin, kod iptal).
   * "inspected": ürün incelendi, müşteriye geri gönderilecek. Boş: eski kayıt.
   */
  stage?: "before_arrival" | "inspected" | null
  /** İnceleme fotoğrafları (ret kanıtı) */
  photos?: { url: string }[]
}

export type SendBackEmailKind = "shipped" | "returned" | "closed" | "disposed"

export type SendBackCustomerData = {
  kind: SendBackEmailKind
  orderDisplayId: string
  items: ReturnEmailLine[]
  carrierName?: string | null
  trackingNumber?: string | null
  trackingUrl?: string | null
  /** "returned": bu tarihe kadar bekletilir (ISO) */
  holdUntil?: string | null
  holdDays?: number
}

function itemRowsHtml(items: ReturnEmailLine[]): string {
  return items
    .map((item) => {
      const meta = [item.variantLabel, item.reasonLabel]
        .filter(Boolean)
        .join(" · ")
      return `<tr>
        <td style="padding:12px 0;border-bottom:1px solid ${EMAIL_STYLES.borderColor};">
          <strong style="color:${EMAIL_STYLES.brandColor};">${escapeHtml(item.title)}</strong>
          ${
            meta
              ? `<br><span style="font-size:13px;color:${EMAIL_STYLES.mutedColor};">${escapeHtml(meta)}</span>`
              : ""
          }
        </td>
        <td style="padding:12px 8px;border-bottom:1px solid ${EMAIL_STYLES.borderColor};text-align:center;color:${EMAIL_STYLES.mutedColor};">${item.quantity}</td>
      </tr>`
    })
    .join("")
}

function itemRowsText(items: ReturnEmailLine[]): string {
  return items
    .map((item) => {
      const meta = [item.variantLabel, item.reasonLabel]
        .filter(Boolean)
        .join(" · ")
      return `- ${item.title}${meta ? ` (${meta})` : ""} x${item.quantity}`
    })
    .join("\n")
}

/** 1) Müşteriye — iade talebi alındı (+ varsa kargo iade etiketi/takip) */
export function buildReturnRequestedCustomerEmail(
  data: ReturnRequestedCustomerData
): { subject: string; html: string; text: string } {
  const {
    returnId,
    orderDisplayId,
    items,
    customerNote,
    trackingNumber,
    trackingUrl,
    labelUrl,
    carrierCode,
    mode = "code",
  } = data
  const hasLabel = Boolean(trackingNumber || labelUrl || trackingUrl)
  // Etiket yok: adaptörlü kargoda kod ayrı mailde gelir; elle kargoda müşteri adrese gönderir.
  if (!hasLabel && mode !== "address") {
    return buildReturnAwaitingCodeCustomerEmail({ orderDisplayId, items, customerNote })
  }
  const subject = trackingNumber
    ? `İade Etiketiniz Hazır — #${orderDisplayId}`
    : `İade Talebiniz Alındı — #${orderDisplayId}`
  const addressHtml = escapeHtml(COMPANY.address)

  const labelBlockHtml = hasLabel
    ? `<div style="margin:0 0 24px;padding:16px;background:${EMAIL_STYLES.bgColor};border-radius:6px;">
      ${
        carrierCode
          ? `<p style="margin:0 0 8px;font-size:14px;color:${EMAIL_STYLES.mutedColor};">Kargo: <strong style="color:${EMAIL_STYLES.brandColor};">${escapeHtml(carrierCode)}</strong></p>`
          : ""
      }
      ${
        trackingNumber
          ? `<p style="margin:0 0 8px;font-size:14px;">Şubeye vereceğiniz kod: <strong>${escapeHtml(trackingNumber)}</strong></p>
      <p style="margin:0 0 12px;font-size:13px;color:${EMAIL_STYLES.mutedColor};">Kargo şubesinde bu kodu söyleyin. Etiketi yazdırdıysanız pakete yapıştırmanız yeterli.</p>`
          : ""
      }
      ${
        labelUrl
          ? `<p style="margin:16px 0 0;text-align:center;">
        <a href="${escapeHtml(labelUrl)}" target="_blank" style="display:inline-block;padding:14px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:3px;background:${EMAIL_STYLES.brandColor};">
          İade etiketini indir
        </a>
      </p>`
          : ""
      }
      ${
        trackingUrl
          ? `<p style="margin:12px 0 0;font-size:13px;text-align:center;">
        <a href="${escapeHtml(trackingUrl)}" target="_blank" style="color:${EMAIL_STYLES.accentColor};">Kargo takibi</a>
      </p>`
          : ""
      }
    </div>`
    : ""

  const stepsHtml = hasLabel
    ? `
    <ol style="margin:0;padding-left:1.2rem;font-size:14px;line-height:22px;color:${EMAIL_STYLES.mutedColor};">
      <li style="margin-bottom:8px;">Ürünü açılmamış orijinal ambalajında, hasarsız şekilde paketleyin.</li>
      <li style="margin-bottom:8px;">${
        trackingNumber
          ? "Kargo şubesinde yukarıdaki kodu verin. Etiketi yazdırdıysanız pakete yapıştırıp teslim edin."
          : "İade etiketini yazdırıp pakete yapıştırın, ardından paketi kargo firmasına teslim edin."
      }</li>
      <li>Ürün tarafımıza ulaşınca incelenir; onay sonrası ödemeniz iade edilir.</li>
    </ol>`
    : `
    <ol style="margin:0;padding-left:1.2rem;font-size:14px;line-height:22px;color:${EMAIL_STYLES.mutedColor};">
      <li style="margin-bottom:8px;">Ürünü açılmamış orijinal ambalajında, hasarsız şekilde paketleyin.</li>
      <li style="margin-bottom:8px;">Dilediğiniz kargo firmasıyla aşağıdaki adrese gönderin. Kargo ücreti, ayıplı ürün dışında alıcıya aittir.</li>
      <li style="margin-bottom:8px;">Kargo takip numaranızı ${escapeHtml(COMPANY.emailOps)} adresine iletirseniz işlem hızlanır.</li>
      <li>Ürün tarafımıza ulaşınca incelenir; onay sonrası ödemeniz iade edilir.</li>
    </ol>`

  const addressBlock = hasLabel
    ? ""
    : `<h2 style="margin:0 0 8px;font-size:16px;color:${EMAIL_STYLES.brandColor};">Kargolama adresi</h2>
    <p style="margin:0 0 8px;font-size:14px;line-height:22px;color:${EMAIL_STYLES.mutedColor};">
      ${escapeHtml(COMPANY.legalName)}<br>${addressHtml}
    </p>
    <p style="margin:0 0 24px;font-size:13px;color:${EMAIL_STYLES.mutedColor};">
      Tel: ${escapeHtml(COMPANY.phone)} · ${escapeHtml(COMPANY.emailOps)}
    </p>`

  const html = emailLayout(`
    <h1 style="margin:0 0 8px;font-size:22px;color:${EMAIL_STYLES.brandColor};">${
      hasLabel ? "İade etiketiniz hazır" : "İade talebiniz alındı"
    }</h1>
    <p style="margin:0 0 24px;font-size:15px;color:${EMAIL_STYLES.mutedColor};line-height:24px;">
      ${
        trackingNumber
          ? "Talebiniz kayda geçti. Kargo şubesinde aşağıdaki kodu verin."
          : hasLabel
            ? "Talebiniz kayda geçti. Ürünü aşağıdaki iade etiketi ile gönderin."
            : "Talebiniz kayda geçti. Ürünü aşağıdaki adrese kargolamanız gerekiyor."
      }
    </p>

    <p style="margin:0 0 24px;padding:16px;background:${EMAIL_STYLES.bgColor};border-radius:6px;font-size:15px;">
      <strong>Sipariş No:</strong> #${escapeHtml(orderDisplayId)}
    </p>

    ${labelBlockHtml}

    <h2 style="margin:0 0 12px;font-size:16px;color:${EMAIL_STYLES.brandColor};">İade edilen ürünler</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <th align="left" style="padding:8px 0;font-size:12px;color:${EMAIL_STYLES.mutedColor};border-bottom:2px solid ${EMAIL_STYLES.borderColor};">Ürün</th>
        <th style="padding:8px;font-size:12px;color:${EMAIL_STYLES.mutedColor};border-bottom:2px solid ${EMAIL_STYLES.borderColor};">Adet</th>
      </tr>
      ${itemRowsHtml(items)}
    </table>

    ${
      customerNote
        ? `<p style="margin:0 0 24px;font-size:14px;color:${EMAIL_STYLES.mutedColor};"><strong>Notunuz:</strong> ${escapeHtml(customerNote)}</p>`
        : ""
    }

    ${addressBlock}

    <h2 style="margin:0 0 8px;font-size:16px;color:${EMAIL_STYLES.brandColor};">Sonraki adımlar</h2>
    ${stepsHtml}
  `)

  const labelText = hasLabel
    ? [
        carrierCode ? `Kargo: ${carrierCode}` : "",
        trackingNumber ? `Şubeye vereceğiniz kod: ${trackingNumber}` : "",
        labelUrl ? `Etiket: ${labelUrl}` : "",
        trackingUrl ? `Takip: ${trackingUrl}` : "",
        "",
        trackingNumber
          ? "Kargo şubesinde bu kodu söyleyin. Etiketi yazdırdıysanız pakete yapıştırmanız yeterli."
          : "Ürünü iade etiketi ile gönderin.",
        "",
      ]
        .filter((line, i, arr) => line !== "" || (i > 0 && arr[i - 1] !== ""))
        .join("\n")
    : `Kargolama adresi:
${COMPANY.legalName}
${COMPANY.address}
Tel: ${COMPANY.phone} · ${COMPANY.emailOps}
`

  const stepsText = hasLabel
    ? `Sonraki adımlar:
1. Ürünü açılmamış orijinal ambalajında, hasarsız şekilde paketleyin.
2. ${
        trackingNumber
          ? "Kargo şubesinde yukarıdaki kodu verin. Etiketi yazdırdıysanız pakete yapıştırıp teslim edin."
          : "İade etiketini yazdırıp pakete yapıştırın, ardından paketi kargo firmasına teslim edin."
      }
3. Ürün tarafımıza ulaşınca incelenir; onay sonrası ödemeniz iade edilir.`
    : `Sonraki adımlar:
1. Ürünü açılmamış orijinal ambalajında, hasarsız şekilde paketleyin.
2. Dilediğiniz kargo firmasıyla yukarıdaki adrese gönderin (kargo ücreti, ayıplı ürün dışında alıcıya aittir).
3. Kargo takip numaranızı ${COMPANY.emailOps} adresine iletirseniz işlem hızlanır.
4. Ürün tarafımıza ulaşınca incelenir; onay sonrası ödemeniz iade edilir.`

  const text = `${subject}

Sipariş No: #${orderDisplayId}

${labelText}
İade edilen ürünler:
${itemRowsText(items)}
${customerNote ? `\nNotunuz: ${customerNote}\n` : ""}
${stepsText}

— Es Çay`

  return { subject, html, text }
}

function carrierLine(): string {
  const n = COMPANY.returnCarrierName
  return n ? `<strong>${escapeHtml(n)}</strong>` : "kargo firmamız"
}

function firmInfoHtml(): string {
  return COMPANY.returnCustomerNumber
    ? ` Önce firma numaramızı <strong>${escapeHtml(COMPANY.returnCustomerNumber)}</strong>, ardından iade kodunuzu söyleyin.`
    : ""
}

function returnStepsHtml(code?: string): string {
  return `
    <ol style="margin:0;padding-left:1.2rem;font-size:14px;line-height:22px;color:${EMAIL_STYLES.mutedColor};">
      <li style="margin-bottom:8px;">Ürünü açılmamış orijinal ambalajında paketleyin.</li>
      <li style="margin-bottom:8px;">${
        code
          ? `Paketi ${carrierLine()} şubesine götürün ve iade kodunuz <strong>${escapeHtml(code)}</strong>'u söyleyin.${firmInfoHtml()} Alıcı firma sorulursa: <strong>${escapeHtml(COMPANY.legalName)}</strong>.`
          : `İade kodunuz e-postayla gelince paketi ${carrierLine()} şubesine götürün; şubede iade kodunuzu söyleyeceksiniz.`
      } Etiket yazdırmanıza gerek yok.</li>
      <li>Ürün tarafımıza ulaşınca incelenir; onay sonrası ödemeniz iade edilir.</li>
    </ol>`
}

function returnStepsText(code?: string): string {
  const carrier = COMPANY.returnCarrierName || "kargo firmamız"
  const firm = COMPANY.returnCustomerNumber ? ` Önce firma numaramızı ${COMPANY.returnCustomerNumber}, ardından iade kodunuzu söyleyin.` : ""
  return `Sonraki adımlar:
1. Ürünü açılmamış orijinal ambalajında paketleyin.
2. ${
    code
      ? `Paketi ${carrier} şubesine götürün ve iade kodunuz ${code}'u söyleyin.${firm} Alıcı firma sorulursa: ${COMPANY.legalName}.`
      : `İade kodunuz e-postayla gelince paketi ${carrier} şubesine götürün; şubede iade kodunuzu söyleyeceksiniz.`
  } Etiket yazdırmanıza gerek yok.
3. Ürün tarafımıza ulaşınca incelenir; onay sonrası ödemeniz iade edilir.`
}

/** 1a) Müşteriye — talep alındı, iade kodu ayrıca gelecek (kod gelmeden kargolamayın). */
export function buildReturnAwaitingCodeCustomerEmail(data: {
  orderDisplayId: string
  items: ReturnEmailLine[]
  customerNote?: string | null
}): { subject: string; html: string; text: string } {
  const subject = `İade Talebiniz Alındı — #${data.orderDisplayId}`
  const html = emailLayout(`
    <h1 style="margin:0 0 8px;font-size:22px;color:${EMAIL_STYLES.brandColor};">İade talebiniz alındı</h1>
    <p style="margin:0 0 24px;font-size:15px;color:${EMAIL_STYLES.mutedColor};line-height:24px;">
      Talebiniz kayda geçti. <strong>İade kodunuz en geç 1 iş günü içinde e-postayla iletilecek.</strong>
      Lütfen kod gelmeden ürünü kargoya vermeyin.
    </p>
    <p style="margin:0 0 24px;padding:16px;background:${EMAIL_STYLES.bgColor};border-radius:6px;font-size:15px;">
      <strong>Sipariş No:</strong> #${escapeHtml(data.orderDisplayId)}
    </p>
    <h2 style="margin:0 0 12px;font-size:16px;color:${EMAIL_STYLES.brandColor};">İade edilen ürünler</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <th align="left" style="padding:8px 0;font-size:12px;color:${EMAIL_STYLES.mutedColor};border-bottom:2px solid ${EMAIL_STYLES.borderColor};">Ürün</th>
        <th style="padding:8px;font-size:12px;color:${EMAIL_STYLES.mutedColor};border-bottom:2px solid ${EMAIL_STYLES.borderColor};">Adet</th>
      </tr>
      ${itemRowsHtml(data.items)}
    </table>
    ${
      data.customerNote
        ? `<p style="margin:0 0 24px;font-size:14px;color:${EMAIL_STYLES.mutedColor};"><strong>Notunuz:</strong> ${escapeHtml(data.customerNote)}</p>`
        : ""
    }
    <h2 style="margin:0 0 8px;font-size:16px;color:${EMAIL_STYLES.brandColor};">Sonraki adımlar</h2>
    ${returnStepsHtml()}
  `)
  const text = `${subject}

Talebiniz kayda geçti. İade kodunuz en geç 1 iş günü içinde e-postayla iletilecek. Lütfen kod gelmeden ürünü kargoya vermeyin.

Sipariş No: #${data.orderDisplayId}

İade edilen ürünler:
${itemRowsText(data.items)}
${data.customerNote ? `\nNotunuz: ${data.customerNote}\n` : ""}
${returnStepsText()}

— Es Çay`
  return { subject, html, text }
}

/** 1b) Müşteriye — kodlu iade kodu (admin panelden veya adaptörden). */
export function buildReturnCodeCustomerEmail(data: {
  orderDisplayId: string
  code: string
  items: ReturnEmailLine[]
  /** Kargo firmasının iade etiketi linki (varsa; ör. DHL returnOrderLabelURL). */
  labelUrl?: string | null
}): { subject: string; html: string; text: string } {
  const subject = `İade Kodunuz — #${data.orderDisplayId}`
  const labelUrl = data.labelUrl && /^https:\/\//i.test(data.labelUrl) ? data.labelUrl : ""
  const html = emailLayout(`
    <h1 style="margin:0 0 8px;font-size:22px;color:${EMAIL_STYLES.brandColor};">İade kodunuz hazır</h1>
    <p style="margin:0 0 24px;font-size:15px;color:${EMAIL_STYLES.mutedColor};line-height:24px;">
      Paketinizi ${carrierLine()} şubesine teslim edebilirsiniz.
    </p>
    <div style="margin:0 0 24px;padding:16px;background:${EMAIL_STYLES.bgColor};border-radius:6px;font-size:15px;line-height:26px;">
      <strong>Firma adı:</strong> ${escapeHtml(COMPANY.legalName)}<br>
      ${COMPANY.returnCustomerNumber ? `<strong>Firma numarası:</strong> ${escapeHtml(COMPANY.returnCustomerNumber)}<br>` : ""}
      <strong>İade kodu:</strong> <span style="font-size:18px;">${escapeHtml(data.code)}</span><br>
      <strong>Sipariş No:</strong> #${escapeHtml(data.orderDisplayId)}
      ${labelUrl ? `<br><strong>İade etiketi:</strong> <a href="${escapeHtml(labelUrl)}" style="color:${EMAIL_STYLES.brandColor};">${escapeHtml(labelUrl)}</a>` : ""}
    </div>
    <h2 style="margin:0 0 12px;font-size:16px;color:${EMAIL_STYLES.brandColor};">İade edilen ürünler</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <th align="left" style="padding:8px 0;font-size:12px;color:${EMAIL_STYLES.mutedColor};border-bottom:2px solid ${EMAIL_STYLES.borderColor};">Ürün</th>
        <th style="padding:8px;font-size:12px;color:${EMAIL_STYLES.mutedColor};border-bottom:2px solid ${EMAIL_STYLES.borderColor};">Adet</th>
      </tr>
      ${itemRowsHtml(data.items)}
    </table>
    <h2 style="margin:0 0 8px;font-size:16px;color:${EMAIL_STYLES.brandColor};">Nasıl gönderilir?</h2>
    ${returnStepsHtml(data.code)}
  `)
  const text = `${subject}

Firma adı: ${COMPANY.legalName}
${COMPANY.returnCustomerNumber ? `Firma numarası: ${COMPANY.returnCustomerNumber}\n` : ""}İade kodu: ${data.code}
Sipariş No: #${data.orderDisplayId}
${labelUrl ? `İade etiketi: ${labelUrl}\n` : ""}
İade edilen ürünler:
${itemRowsText(data.items)}

${returnStepsText(data.code)}

— Es Çay`
  return { subject, html, text }
}

/** 2) Satıcıya — yeni iade talebi (+ varsa kargo iade takip) */
export function buildReturnRequestedSellerEmail(
  data: ReturnRequestedSellerData
): { subject: string; html: string; text: string } {
  const {
    returnId,
    orderDisplayId,
    orderId,
    customerEmail,
    customerName,
    items,
    customerNote,
    source,
    trackingNumber,
    trackingUrl,
    labelUrl,
    carrierCode,
  } = data

  const subject = trackingNumber
    ? `İade kargosu oluştu — #${orderDisplayId}`
    : `Yeni iade talebi — #${orderDisplayId}`
  const who = customerName?.trim()
    ? `${customerName.trim()} <${customerEmail}>`
    : customerEmail

  const shipHtml =
    trackingNumber || trackingUrl || labelUrl
      ? `<p style="margin:0 0 24px;padding:16px;background:${EMAIL_STYLES.bgColor};border-radius:6px;font-size:14px;line-height:22px;">
      <strong>İade kargo:</strong><br>
      ${carrierCode ? `Firma: ${escapeHtml(carrierCode)}<br>` : ""}
      ${trackingNumber ? `Takip No: <strong>${escapeHtml(trackingNumber)}</strong><br>` : ""}
      ${trackingUrl ? `Takip: <a href="${escapeHtml(trackingUrl)}">${escapeHtml(trackingUrl)}</a><br>` : ""}
      ${labelUrl ? `Etiket: <a href="${escapeHtml(labelUrl)}">${escapeHtml(labelUrl)}</a>` : ""}
    </p>`
      : `<p style="margin:0 0 24px;padding:16px;background:#fff4e5;border-radius:6px;font-size:14px;line-height:22px;">
      <strong>Yapılacak:</strong> Kargo firmasının panelinden bu müşteri için <strong>kodlu iade</strong> açın,
      ardından panelde sipariş sayfasındaki İade kutusuna kodu yazıp &quot;Kodu müşteriye gönder&quot;e basın.
      Müşteriye en geç 1 iş günü içinde kod gönderileceği yazıldı.
    </p>`

  const html = emailLayout(`
    <h1 style="margin:0 0 8px;font-size:22px;color:${EMAIL_STYLES.brandColor};">${
      trackingNumber ? "İade kargosu oluşturuldu" : "Yeni iade talebi"
    }</h1>
    <p style="margin:0 0 24px;font-size:15px;color:${EMAIL_STYLES.mutedColor};line-height:24px;">
      Storefront üzerinden yeni bir iade talebi açıldı${
        trackingNumber ? "; iade etiketi/takip oluşturuldu" : ""
      }.
    </p>

    <p style="margin:0 0 24px;padding:16px;background:${EMAIL_STYLES.bgColor};border-radius:6px;font-size:14px;line-height:22px;">
      <strong>İade No:</strong> ${escapeHtml(returnId)}<br>
      <strong>Sipariş:</strong> #${escapeHtml(orderDisplayId)} (${escapeHtml(orderId)})<br>
      <strong>Müşteri:</strong> ${escapeHtml(who)}<br>
      <strong>Kaynak:</strong> ${escapeHtml(source || "—")}
    </p>

    ${shipHtml}

    <h2 style="margin:0 0 12px;font-size:16px;color:${EMAIL_STYLES.brandColor};">Kalemler</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <th align="left" style="padding:8px 0;font-size:12px;color:${EMAIL_STYLES.mutedColor};border-bottom:2px solid ${EMAIL_STYLES.borderColor};">Ürün / Sebep</th>
        <th style="padding:8px;font-size:12px;color:${EMAIL_STYLES.mutedColor};border-bottom:2px solid ${EMAIL_STYLES.borderColor};">Adet</th>
      </tr>
      ${itemRowsHtml(items)}
    </table>

    ${
      customerNote
        ? `<h2 style="margin:0 0 8px;font-size:16px;color:${EMAIL_STYLES.brandColor};">Müşteri notu</h2>
    <p style="margin:0;font-size:14px;line-height:22px;color:${EMAIL_STYLES.mutedColor};">${escapeHtml(customerNote)}</p>`
        : `<p style="margin:0;font-size:13px;color:${EMAIL_STYLES.mutedColor};">Müşteri notu yok.</p>`
    }
  `)

  const shipText =
    trackingNumber || trackingUrl || labelUrl
      ? `
İade kargo:
${carrierCode ? `Firma: ${carrierCode}` : ""}
${trackingNumber ? `Takip No: ${trackingNumber}` : ""}
${trackingUrl ? `Takip: ${trackingUrl}` : ""}
${labelUrl ? `Etiket: ${labelUrl}` : ""}
`
      : `
YAPILACAK: Kargo firmasının panelinden kodlu iade açın, kodu panelde sipariş sayfasındaki İade kutusundan müşteriye gönderin (1 iş günü içinde).
`

  const text = `${subject}

İade No: ${returnId}
Sipariş: #${orderDisplayId} (${orderId})
Müşteri: ${who}
Kaynak: ${source || "—"}
${shipText}
Kalemler:
${itemRowsText(items)}
${customerNote ? `\nMüşteri notu:\n${customerNote}\n` : "\nMüşteri notu yok.\n"}
— Es Çay`

  return { subject, html, text }
}

/** 3) Müşteriye — iade onaylandı, para ödeme kuruluşuna iletildi (tamamlanma: paytr-refund-tracking) */
export function buildReturnRefundedCustomerEmail(
  data: ReturnRefundedCustomerData
): { subject: string; html: string; text: string } {
  const {
    returnId,
    orderDisplayId,
    amount,
    currencyCode = "TRY",
    shippingIncluded,
  } = data
  const notAccepted = data.notAccepted || []
  const notAcceptedPhotos = (data.notAcceptedPhotos || []).filter((p) => /^https?:\/\//i.test(p.url))
  const subject = `İadeniz Onaylandı — #${orderDisplayId}`
  const money = formatMoney(amount, currencyCode)

  const html = emailLayout(`
    <h1 style="margin:0 0 8px;font-size:22px;color:${EMAIL_STYLES.brandColor};">İadeniz onaylandı</h1>
    <p style="margin:0 0 24px;font-size:15px;color:${EMAIL_STYLES.mutedColor};line-height:24px;">
      Ürününüz tarafımıza ulaştı; iade tutarı kartınıza iade edilmek üzere ödeme kuruluşuna iletildi.
    </p>

    <p style="margin:0 0 24px;padding:16px;background:${EMAIL_STYLES.bgColor};border-radius:6px;font-size:15px;line-height:22px;">
      <strong>İade No:</strong> ${escapeHtml(returnId)}<br>
      <strong>Sipariş No:</strong> #${escapeHtml(orderDisplayId)}<br>
      <strong>İade tutarı:</strong> ${money}
      ${
        shippingIncluded
          ? `<br><span style="font-size:13px;color:${EMAIL_STYLES.mutedColor};">Kargo ücreti iadeye dahildir.</span>`
          : ""
      }
    </p>

    ${
      notAccepted.length
        ? `<h2 style="margin:0 0 12px;font-size:16px;color:${EMAIL_STYLES.brandColor};">İadesi kabul edilmeyen ürünler</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
      ${itemRowsHtml(notAccepted)}
    </table>
    <p style="margin:0 0 24px;font-size:14px;line-height:22px;color:${EMAIL_STYLES.mutedColor};">
      Bu ürünler için para iadesi yapılmamıştır.${
        data.notAcceptedReason ? ` Sebep: ${escapeHtml(data.notAcceptedReason)}` : ""
      }
      Ürünleri, kargo ücreti bize ait olmak üzere teslimat adresinize geri göndereceğiz. Geri
      gönderilmesini istemiyorsanız ${escapeHtml(COMPANY.emailOps)} adresine yazın; yazılı onayınızla imha ederiz.
    </p>${
      notAcceptedPhotos.length
        ? `
    <p style="margin:0 0 24px;">
      ${notAcceptedPhotos
        .map(
          (p, i) =>
            `<a href="${escapeHtml(p.url)}" style="display:inline-block;margin:0 8px 8px 0;"><img src="${escapeHtml(p.url)}" alt="İnceleme fotoğrafı ${i + 1}" width="160" style="width:160px;max-width:100%;height:auto;border-radius:6px;border:1px solid ${EMAIL_STYLES.borderColor};"></a>`
        )
        .join("")}
    </p>`
        : ""
    }`
        : ""
    }

    <p style="margin:0 0 16px;font-size:14px;line-height:22px;color:${EMAIL_STYLES.mutedColor};">
      İade, ödemeyi yaptığınız karta (kredi / banka kartı) yapılır. Tutar azami
      <strong>14 gün</strong> içinde hesabınıza yansır; bankaya yansıma süresi bankanızın
      işlem sürecine bağlıdır.
    </p>

    <p style="margin:0;font-size:13px;color:${EMAIL_STYLES.mutedColor};line-height:20px;">
      Sorularınız için ${escapeHtml(COMPANY.emailOps)} adresine yazabilirsiniz.
    </p>
  `)

  const text = `İadeniz Onaylandı — #${orderDisplayId}

İade No: ${returnId}
Sipariş No: #${orderDisplayId}
İade tutarı: ${money}${shippingIncluded ? " (kargo dahil)" : ""}
${
  notAccepted.length
    ? `\nİadesi kabul edilmeyen ürünler (para iadesi yapılmadı):\n${itemRowsText(notAccepted)}${
        data.notAcceptedReason ? `\nSebep: ${data.notAcceptedReason}` : ""
      }\nBu ürünleri kargo ücreti bize ait olmak üzere adresinize geri göndereceğiz; istemiyorsanız ${COMPANY.emailOps} adresine yazın, onayınızla imha ederiz.${
        notAcceptedPhotos.length ? `\nİnceleme fotoğrafları:\n${notAcceptedPhotos.map((p) => p.url).join("\n")}` : ""
      }\n`
    : ""
}
İade, ödemeyi yaptığınız karta (kredi / banka kartı) yapılır. Tutar azami 14 gün içinde hesabınıza yansır; bankaya yansıma süresi bankanızın işlem sürecine bağlıdır.

Sorularınız için: ${COMPANY.emailOps}

— Es Çay`

  return { subject, html, text }
}

/** 4) Müşteriye — iade reddedildi */
export function buildReturnRejectedCustomerEmail(
  data: ReturnRejectedCustomerData
): { subject: string; html: string; text: string } {
  const { returnId, orderDisplayId, reason, items } = data
  const stage = data.stage || null
  const photos = (data.photos || []).filter((p) => /^https?:\/\//i.test(p.url))
  const subject = `İade Talebiniz Değerlendirildi — #${orderDisplayId}`

  const intro =
    stage === "before_arrival"
      ? "İade talebiniz incelendi. Maalesef bu talep kabul edilememiştir; ödeme iadesi yapılmayacaktır."
      : "Gönderdiğiniz ürün incelendi. Maalesef bu iade talebi kabul edilememiştir; ödeme iadesi yapılmayacaktır."
  const next =
    stage === "before_arrival"
      ? `Lütfen ürünü kargoya vermeyin. Size daha önce iletilen iade kodu artık geçerli değildir.`
      : stage === "inspected"
        ? `Ürününüzü, kargo ücreti bize ait olmak üzere teslimat adresinize geri göndereceğiz. Kargoya verildiğinde takip numarasını e-postayla ileteceğiz. Ürünün geri gönderilmesini istemiyorsanız ${COMPANY.emailOps} adresine yazın; yazılı onayınızla ürünü imha ederiz.`
        : `Ürününüzün iadesi veya yeniden gönderimi hakkında bilgi için ${COMPANY.emailOps} adresine yazabilirsiniz.`

  const html = emailLayout(`
    <h1 style="margin:0 0 8px;font-size:22px;color:${EMAIL_STYLES.brandColor};">İade talebiniz değerlendirildi</h1>
    <p style="margin:0 0 24px;font-size:15px;color:${EMAIL_STYLES.mutedColor};line-height:24px;">
      ${escapeHtml(intro)}
    </p>

    <p style="margin:0 0 24px;padding:16px;background:${EMAIL_STYLES.bgColor};border-radius:6px;font-size:15px;line-height:22px;">
      <strong>İade No:</strong> ${escapeHtml(returnId)}<br>
      <strong>Sipariş No:</strong> #${escapeHtml(orderDisplayId)}
      ${
        reason
          ? `<br><strong>Sebep:</strong> ${escapeHtml(reason)}`
          : ""
      }
    </p>

    ${
      items.length
        ? `<h2 style="margin:0 0 12px;font-size:16px;color:${EMAIL_STYLES.brandColor};">İlgili ürünler</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <th align="left" style="padding:8px 0;font-size:12px;color:${EMAIL_STYLES.mutedColor};border-bottom:2px solid ${EMAIL_STYLES.borderColor};">Ürün</th>
        <th style="padding:8px;font-size:12px;color:${EMAIL_STYLES.mutedColor};border-bottom:2px solid ${EMAIL_STYLES.borderColor};">Adet</th>
      </tr>
      ${itemRowsHtml(items)}
    </table>`
        : ""
    }

    ${
      photos.length
        ? `<h2 style="margin:0 0 12px;font-size:16px;color:${EMAIL_STYLES.brandColor};">İnceleme fotoğrafları</h2>
    <p style="margin:0 0 24px;">
      ${photos
        .map(
          (p, i) =>
            `<a href="${escapeHtml(p.url)}" style="display:inline-block;margin:0 8px 8px 0;"><img src="${escapeHtml(p.url)}" alt="İnceleme fotoğrafı ${i + 1}" width="160" style="width:160px;max-width:100%;height:auto;border-radius:6px;border:1px solid ${EMAIL_STYLES.borderColor};"></a>`
        )
        .join("")}
    </p>`
        : ""
    }

    <p style="margin:0 0 16px;font-size:14px;line-height:22px;color:${EMAIL_STYLES.mutedColor};">
      ${escapeHtml(next)}
    </p>

    <p style="margin:0;font-size:13px;color:${EMAIL_STYLES.mutedColor};line-height:20px;">
      Sorularınız için ${escapeHtml(COMPANY.emailOps)}.
    </p>
  `)

  const text = `İade Talebiniz Değerlendirildi — #${orderDisplayId}

${intro}

İade No: ${returnId}
Sipariş No: #${orderDisplayId}
${reason ? `Sebep: ${reason}\n` : ""}
${items.length ? `Ürünler:\n${itemRowsText(items)}\n` : ""}${
    photos.length ? `\nİnceleme fotoğrafları:\n${photos.map((p) => p.url).join("\n")}\n` : ""
  }
${next}

Sorularınız için: ${COMPANY.emailOps}

— Es Çay`

  return { subject, html, text }
}

function longDateTr(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ""
  return new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Istanbul" }).format(new Date(t))
}

/**
 * 5) Müşteriye — reddedilen ürünün geri gönderimi: kargoya verildi / teslim alınmadı, bize
 * döndü (bekleme süresi) / bekleme süresi doldu / onayla imha edildi.
 */
export function buildSendBackCustomerEmail(data: SendBackCustomerData): { subject: string; html: string; text: string } {
  const { kind, orderDisplayId, items } = data
  const carrier = data.carrierName?.trim() || "kargo firması"
  const until = longDateTr(data.holdUntil)
  const days = data.holdDays ?? 14

  const copy: Record<SendBackEmailKind, { subject: string; title: string; body: string }> = {
    shipped: {
      subject: `Ürününüz Size Geri Gönderildi — #${orderDisplayId}`,
      title: "Ürününüz size geri gönderildi",
      body: `İadesi kabul edilmeyen ürününüz ${carrier} ile teslimat adresinize gönderilmek üzere hazırlandı. Kargo ücreti bize aittir.`,
    },
    returned: {
      subject: `Paketiniz Teslim Edilemedi — #${orderDisplayId}`,
      title: "Paketiniz teslim edilemedi",
      body: `Size geri gönderdiğimiz ürün teslim alınmadığı için depomuza döndü. Ürünü ${days} gün boyunca${until ? ` (${until} tarihine kadar)` : ""} sizin için saklıyoruz. Bu süre içinde ${COMPANY.emailOps} adresine yazarsanız yeniden göndeririz ya da onayınızla imha ederiz.`,
    },
    closed: {
      subject: `Geri Gönderim Kaydınız Kapatıldı — #${orderDisplayId}`,
      title: "Geri gönderim kaydınız kapatıldı",
      body: `Teslim alınmayıp depomuza dönen ürününüz için ${days} günlük bekleme süresi doldu ve geri gönderim kaydı kapatıldı. Ürününüzle ilgili talebiniz için ${COMPANY.emailOps} adresine yazabilirsiniz.`,
    },
    disposed: {
      subject: `Ürününüz İmha Edildi — #${orderDisplayId}`,
      title: "Ürününüz onayınızla imha edildi",
      body: "İadesi kabul edilmeyen ürününüz, verdiğiniz onay doğrultusunda imha edilmiştir. Bu ürün için ödeme iadesi yapılmamıştır.",
    },
  }
  const c = copy[kind]
  const tracking = kind === "shipped" && data.trackingNumber ? data.trackingNumber : ""

  const html = emailLayout(`
    <h1 style="margin:0 0 8px;font-size:22px;color:${EMAIL_STYLES.brandColor};">${escapeHtml(c.title)}</h1>
    <p style="margin:0 0 24px;font-size:15px;color:${EMAIL_STYLES.mutedColor};line-height:24px;">
      ${escapeHtml(c.body)}
    </p>

    <p style="margin:0 0 24px;padding:16px;background:${EMAIL_STYLES.bgColor};border-radius:6px;font-size:15px;line-height:22px;">
      <strong>Sipariş No:</strong> #${escapeHtml(orderDisplayId)}
      ${
        tracking
          ? `<br><strong>Kargo:</strong> ${escapeHtml(carrier)}<br><strong>Takip No:</strong> ${
              data.trackingUrl
                ? `<a href="${escapeHtml(data.trackingUrl)}" style="color:${EMAIL_STYLES.brandColor};">${escapeHtml(tracking)}</a>`
                : escapeHtml(tracking)
            }`
          : ""
      }
    </p>

    ${
      items.length
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      ${itemRowsHtml(items)}
    </table>`
        : ""
    }

    <p style="margin:0;font-size:13px;color:${EMAIL_STYLES.mutedColor};line-height:20px;">
      Sorularınız için ${escapeHtml(COMPANY.emailOps)}.
    </p>
  `)

  const text = `${c.subject}

${c.body}

Sipariş No: #${orderDisplayId}
${tracking ? `Kargo: ${carrier}\nTakip No: ${tracking}${data.trackingUrl ? `\nTakip: ${data.trackingUrl}` : ""}\n` : ""}${
    items.length ? `\nÜrünler:\n${itemRowsText(items)}\n` : ""
  }
Sorularınız için: ${COMPANY.emailOps}

— Es Çay`

  return { subject: c.subject, html, text }
}
