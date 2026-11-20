import { guardStorePaymentSession } from "../_payment-session-guard"
import {
  stripReservedCartMetadata,
  stripReservedLineItemMetadata,
} from "../_strip-reserved-metadata"

function res() {
  const r = { statusCode: 200, body: undefined as unknown, status: jest.fn(), json: jest.fn() }
  r.status.mockImplementation((c: number) => ((r.statusCode = c), r))
  r.json.mockImplementation((b: unknown) => ((r.body = b), r))
  return r
}

describe("guardStorePaymentSession", () => {
  it.each(["pp_system_default", "pp_havale_havale", "", undefined])(
    "PayTR dışı sağlayıcı reddedilir: %s",
    (provider_id) => {
      const r = res()
      const next = jest.fn()
      guardStorePaymentSession({ body: { provider_id } } as never, r as never, next)
      expect(r.statusCode).toBe(400)
      expect(next).not.toHaveBeenCalled()
    }
  )

  it("PayTR geçer; data yalnız izinli alanları taşır", () => {
    const body = {
      provider_id: "pp_paytr_paytr",
      data: {
        customer_email: "a@b.co",
        phone: "+905551112233",
        cart_items: [{ name: "Çay", unit_price: 100, quantity: 1 }],
        user_ip: "1.1.1.1",
        _stub: true,
        manual_review: true,
        paytr_status: "success",
        paytr_last_failed_at: "2999-01-01",
      },
    }
    const validatedBody = JSON.parse(JSON.stringify(body))
    const next = jest.fn()
    guardStorePaymentSession({ body, validatedBody } as never, res() as never, next)
    expect(next).toHaveBeenCalled()
    for (const d of [body.data, validatedBody.data]) {
      expect(Object.keys(d).sort()).toEqual(["cart_items", "customer_email", "phone", "user_ip"])
    }
  })
})

describe("stripReservedCartMetadata", () => {
  it("sepet metadata'sında yalnız mağaza anahtarları kalır", () => {
    const body = {
      metadata: {
        payment_method: "card",
        marketing_consent: true,
        tracking_consent: false,
        legal_accepted_at: "2026-11-17T10:00:00Z",
        order_note: "zil çalmayın",
        source: "import",
        bizimhesap_invoice: { status: "created" },
        contracts: { source: "medusa" },
        label_printed_at: "x",
        escay_cancel: {},
      },
    }
    const next = jest.fn()
    stripReservedCartMetadata({ body } as never, res() as never, next)
    expect(next).toHaveBeenCalled()
    expect(Object.keys(body.metadata).sort()).toEqual([
      "legal_accepted_at",
      "marketing_consent",
      "order_note",
      "payment_method",
      "tracking_consent",
    ])
  })

  describe("payment_method", () => {
    const env = { ...process.env }
    afterEach(() => {
      process.env = { ...env }
    })
    const run = (payment_method: unknown) => {
      const body = { metadata: { payment_method } as Record<string, unknown> }
      stripReservedCartMetadata({ body } as never, res() as never, jest.fn())
      return body.metadata
    }

    it("havale kapalıyken bank_transfer silinir, card kalır", () => {
      delete process.env.BANK_TRANSFER_ENABLED
      expect(run("bank_transfer")).toEqual({})
      expect(run("card")).toEqual({ payment_method: "card" })
    })

    it("bilinmeyen değer silinir", () => {
      expect(run("cash")).toEqual({})
      expect(run({ x: 1 })).toEqual({})
    })

    it("havale açık ve banka bilgisi tamsa bank_transfer kalır", () => {
      process.env.BANK_TRANSFER_ENABLED = "1"
      process.env.BANK_TRANSFER_IBAN = "TR000000000000000000000000"
      process.env.BANK_TRANSFER_ACCOUNT_NAME = "Hamzalı Çay"
      expect(run("bank_transfer")).toEqual({ payment_method: "bank_transfer" })
    })
  })

  it("sepet oluştururken items[].metadata ağırlık/boyutu silinir", () => {
    const body = {
      items: [
        { variant_id: "v1", quantity: 1, metadata: { weight_kg: 0.001, height: 1, gift: true } },
        { variant_id: "v2", quantity: 1 },
      ],
    }
    stripReservedCartMetadata({ body } as never, res() as never, jest.fn())
    expect(body.items[0].metadata).toEqual({ gift: true })
  })

  it("satır metadata'sı ağırlık/boyut dışında korunur", () => {
    const body = { metadata: { weight_g: 1, width: 2, gift: true, escay_exchange_for_item_id: "li_x", escay_exchange_return_id: "ret_x" } }
    stripReservedLineItemMetadata({ body } as never, res() as never, jest.fn())
    expect(body.metadata).toEqual({ gift: true })
  })
})
