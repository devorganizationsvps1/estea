import {
  isSendBackHoldExpired,
  newSendBack,
  normalizePhotos,
  planRejection,
  readSendBack,
  sendBackHoldUntil,
  sendBackItemsFromAcceptance,
  sendBackNeedsAction,
  sendBackReference,
  SEND_BACK_HOLD_DAYS,
} from "../return-rejection-plan"

const photo = { url: "https://cdn.test/a.jpg" }

describe("planRejection", () => {
  it("paket gelmeden ret: fotoğraf gerekmez, sebep listeden", () => {
    expect(planRejection({ stage: "before_arrival", reason_code: "period_expired" })).toEqual({
      stage: "before_arrival",
      reason_code: "period_expired",
      note: null,
      reason: "İade süresi dolmuş",
      photos: [],
    })
  })

  it("inceleme sonrası ret: en az bir fotoğraf zorunlu", () => {
    expect(() => planRejection({ stage: "inspected", reason_code: "opened" })).toThrow(/fotoğraf/)
    const plan = planRejection({ stage: "inspected", reason_code: "opened", note: " koruma bandı yırtık ", photos: [photo] })
    expect(plan.reason).toBe("Ambalajı açılmış ya da ürün kullanılmış. koruma bandı yırtık")
    expect(plan.photos).toEqual([photo])
  })

  it("aşama ve sebep doğrulanır; sebep seçilen aşamaya ait olmalı", () => {
    expect(() => planRejection({ reason_code: "other", note: "x" })).toThrow(/Paket elinize/)
    expect(() => planRejection({ stage: "before_arrival", reason_code: "opened" })).toThrow(/sebebini/)
    expect(() => planRejection({ stage: "inspected", reason_code: "not_returnable", photos: [photo] })).toThrow(/sebebini/)
    expect(() => planRejection({ stage: "before_arrival", reason_code: "nope" })).toThrow(/sebebini/)
  })

  it("\"Diğer\" açıklama ister; müşteriye yalnız açıklama gider", () => {
    expect(() => planRejection({ stage: "before_arrival", reason_code: "other", note: "  " })).toThrow(/açıklama/)
    expect(planRejection({ stage: "before_arrival", reason_code: "other", note: "Kampanya ürünü" }).reason).toBe("Kampanya ürünü")
  })

  it("teslim alınmış iadede aşama her zaman inceleme", () => {
    expect(() => planRejection({ stage: "before_arrival", reason_code: "period_expired" }, { alreadyReceived: true })).toThrow(/fotoğraf/)
    expect(planRejection({ reason_code: "damaged", photos: [photo] }, { alreadyReceived: true }).stage).toBe("inspected")
  })
})

describe("normalizePhotos", () => {
  it("yalnız http(s), tekrarsız, en fazla 8", () => {
    expect(normalizePhotos([photo, photo, "https://cdn.test/b.jpg", { url: "javascript:alert(1)" }, { url: "" }, 5, null])).toEqual([
      photo,
      { url: "https://cdn.test/b.jpg" },
    ])
    expect(normalizePhotos(Array.from({ length: 12 }, (_, i) => `https://cdn.test/${i}.jpg`))).toHaveLength(8)
    expect(normalizePhotos("x")).toEqual([])
  })
})

describe("geri gönderim", () => {
  it("referans iade başına sabit: aynı siparişin iki iadesi çakışmaz", () => {
    expect(sendBackReference("ESC-65", "return_01JABCDEF9")).toBe("ESC-65-GCDEF9")
    expect(sendBackReference("ESC-65", "return_01JABCXYZ1")).not.toBe(sendBackReference("ESC-65", "return_01JABCDEF9"))
  })

  it("kısmi kabulde yalnız kabul edilmeyen adetler geri gider", () => {
    expect(
      sendBackItemsFromAcceptance([
        { item_id: "a", rejected: 1 },
        { item_id: "b", rejected: 0 },
      ])
    ).toEqual([{ item_id: "a", quantity: 1 }])
  })

  it("bize dönen paket 14 gün bekler", () => {
    const returnedAt = "2026-11-25T09:00:00.000Z"
    const hold = sendBackHoldUntil(returnedAt)
    expect(SEND_BACK_HOLD_DAYS).toBe(14)
    expect(hold).toBe("2026-12-09T09:00:00.000Z")
    const sb = { ...newSendBack("rejection", [{ item_id: "a", quantity: 1 }]), status: "returned" as const, returned_at: returnedAt, hold_until: hold }
    expect(isSendBackHoldExpired(sb, new Date("2026-12-09T08:59:00.000Z"))).toBe(false)
    expect(isSendBackHoldExpired(sb, new Date("2026-12-09T09:00:00.000Z"))).toBe(true)
    expect(isSendBackHoldExpired({ ...sb, status: "shipped" }, new Date("2027-01-01T00:00:00.000Z"))).toBe(false)
  })

  it("yapılacak iş: ürün bizde bekliyorsa ya da paket bize döndüyse", () => {
    const meta = (status: string) => ({ escay_send_back: { status, source: "rejection", items: [], created_at: "x" } })
    expect(sendBackNeedsAction(meta("awaiting"))).toBe(true)
    expect(sendBackNeedsAction(meta("returned"))).toBe(true)
    expect(sendBackNeedsAction(meta("shipped"))).toBe(false)
    expect(sendBackNeedsAction(meta("closed"))).toBe(false)
    expect(sendBackNeedsAction({})).toBe(false)
    expect(readSendBack({ escay_send_back: null })).toBeNull()
  })
})
