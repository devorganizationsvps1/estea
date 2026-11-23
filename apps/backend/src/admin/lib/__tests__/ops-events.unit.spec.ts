import { eventGroupTitle, groupEvents, opsEventAction, tidyEventText, type OpsEvent } from "../ops-events"
import { formatTL } from "../money"

const ev = (id: string, title: string, order?: number, extra: Partial<OpsEvent> = {}): OpsEvent =>
  ({ id, kind: "shipment.audit", level: "warning", title, created_at: "2026-11-22T07:50:00Z", order_id: order ? `order_${order}` : null, order_display_id: order ? String(order) : null, ...extra }) as OpsEvent

describe("olay kaydı gruplama", () => {
  it("başlıktaki sipariş no, tarih ve gün sayısı gruplamayı bozmaz", () => {
    expect(eventGroupTitle("15 gündür teslim edilmedi: #23 · 2026-11-22")).toBe("Teslim edilmedi")
    expect(eventGroupTitle("Ödendi ama kargo kaydı yok: #80 · 2026-11-20")).toBe("Ödendi ama kargo kaydı yok")
    expect(eventGroupTitle("Sözleşme PDF'leri oluşturulamadı")).toBe("Sözleşme PDF'leri oluşturulamadı")
  })

  it("aynı olay tek satır; siparişler tekrarsız, en yeni kayıt başta", () => {
    const groups = groupEvents([
      ev("1", "Ödendi ama kargo kaydı yok: #7 · 2026-11-22", 7),
      ev("2", "Ödendi ama kargo kaydı yok: #8 · 2026-11-22", 8),
      ev("3", "10 gündür teslim edilmedi: #76 · 2026-11-22", 76),
      ev("4", "Ödendi ama kargo kaydı yok: #7 · 2026-11-21", 7),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ title: "Ödendi ama kargo kaydı yok", count: 3 })
    expect(groups[0].first.id).toBe("1")
    expect(groups[0].orders.map((o) => o.label)).toEqual(["#7", "#8"])
  })

  it("farklı seviye ya da tür ayrı satır", () => {
    const groups = groupEvents([ev("1", "X"), ev("2", "X", undefined, { level: "error" }), ev("3", "X", undefined, { kind: "payment.alert" })])
    expect(groups).toHaveLength(3)
  })
})

describe("formatTL", () => {
  it("tek biçim: ₺1.849,90", () => {
    expect(formatTL(1849.9)).toBe("₺1.849,90")
    expect(formatTL("149.9")).toBe("₺149,90")
    expect(formatTL(null)).toBe("—")
  })
})

describe("olay metni panelin tutar ve tarih biçiminde", () => {
  it("düz TL ve ISO tarih çevrilir", () => {
    expect(tidyEventText("PayTR iadesi başarısız (1800.00 TL)")).toBe(`PayTR iadesi başarısız (${formatTL(1800)})`)
    expect(tidyEventText("Ödendi ama kargo kaydı yok: #80 · 2026-11-22")).toBe("Ödendi ama kargo kaydı yok: #80, 22.11.2026")
    expect(tidyEventText("Takip no: 565721832746")).toBe("Takip no: 565721832746")
  })
})

describe("olay başına yapılacak iş", () => {
  const audit = (title: string) => opsEventAction({ kind: "shipment.audit", level: "warning", title })

  it("kargo denetimi bulgusuna göre ayrı iş söyler", () => {
    expect(audit("Ödendi ama kargo kaydı yok: #80 · 2026-11-22")).toMatch(/Gönderi aç/)
    expect(audit("6 gündür kargoya verilmedi: #22 · 2026-11-22")).toMatch(/kargoya verin/)
    expect(audit("10 gündür teslim edilmedi: #76 · 2026-11-22")).toMatch(/Kargo firmasını arayıp/)
    expect(audit("10 gündür teslim edilmedi: #76")).not.toMatch(/Gönderi aç/)
  })

  it("bilgi satırında ve tanımsız türde iş yok", () => {
    expect(opsEventAction({ kind: "shipment.audit", level: "info", title: "Kargo denetimi: 8 bulgu" })).toBeNull()
    expect(opsEventAction({ kind: "payment.succeeded", level: "warning", title: "x" })).toBeNull()
  })
})
