import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

/**
 * Medusa'nın kendi para/iade/iptal uçları sunucuda kapalı. Admin'deki butonlar
 * yalnız CSS ile gizleniyordu (hide-native-return-actions); API'den çağrılınca
 * Es Çay iade kaydı, sipariş kilidi, kargo iptali, müşteri maili ve fatura uyarısı
 * atlanıyor, ardından iade kutusundan ikinci iade yapılabiliyordu (Mareen 179de68).
 *
 * Yerine: iade kabul/ret/para iadesi `/admin/returns/:id/{accept,reject,refund}`,
 * sipariş iptali `/admin/orders/:id/escay-cancel`, değişim `/admin/orders/:id/exchange`.
 * Kodumuz bu akışları workflow ile doğrudan çalıştırır, HTTP uçlarına ihtiyaç yok.
 */
export const NATIVE_BLOCKED: { matcher: RegExp; methods: ("POST" | "DELETE")[]; use: string }[] = [
  { matcher: /^\/admin\/payments\/[^/]+\/refund\/?$/, methods: ["POST"], use: "İade kutusu (/admin/returns/:id/refund)" },
  { matcher: /^\/admin\/orders\/[^/]+\/cancel\/?$/, methods: ["POST"], use: "Siparişi iptal et (escay-cancel)" },
  // Sağlayıcı iptali firmanın reddini yutar (DHL'de gönderi açık kalır, yeniden açınca
  // ikinci kayıt oluşur). Kod yolu cancelOpenFulfillmentStrict: firma reddederse durur.
  {
    matcher: /^\/admin\/orders\/[^/]+\/fulfillments\/[^/]+\/cancel\/?$/,
    methods: ["POST"],
    use: "Gönderiyi yeniden aç / Siparişi iptal et",
  },
  // Yerel gönderi oluşturma / kargoya verme / teslim işaretleme: sipariş kilidini, kargo
  // firması kaydını, müşteri mailini ve teslimde kesilen faturayı atlar. Kod bu adımları
  // workflow ile çalıştırır (auto-fulfill-order, carrier-actions); HTTP uçları kullanılmaz.
  {
    matcher: /^\/admin\/orders\/[^/]+\/fulfillments\/?$/,
    methods: ["POST"],
    use: "Sipariş durumu kartı (Gönderi aç)",
  },
  {
    matcher: /^\/admin\/orders\/[^/]+\/fulfillments\/[^/]+\/(shipments|mark-as-delivered)\/?$/,
    methods: ["POST"],
    use: "Sipariş durumu kartı",
  },
  { matcher: /^\/admin\/fulfillments(\/.*)?$/, methods: ["POST"], use: "Sipariş durumu kartı" },
  { matcher: /^\/admin\/returns\/?$/, methods: ["POST"], use: "Müşteri iade talebi / iade kutusu" },
  {
    matcher:
      /^\/admin\/returns\/[^/]+(\/(cancel|dismiss-items|receive|receive-items|request|request-items|shipping-method)(\/.*)?)?\/?$/,
    methods: ["POST", "DELETE"],
    use: "İade kutusu (kabul / ret)",
  },
  { matcher: /^\/admin\/exchanges(\/.*)?$/, methods: ["POST", "DELETE"], use: "Değişim (/admin/orders/:id/exchange)" },
  { matcher: /^\/admin\/claims(\/.*)?$/, methods: ["POST", "DELETE"], use: "İade kutusu" },
  { matcher: /^\/admin\/order-edits(\/.*)?$/, methods: ["POST", "DELETE"], use: "Değişim" },
]

export function blockNativeOrderAction(use: string) {
  return (_req: MedusaRequest, res: MedusaResponse, _next: MedusaNextFunction) => {
    res.status(403).json({
      type: "not_allowed",
      message: `Bu işlem Es Çay'da kapalı; panelde "${use}" kullanın.`,
    })
  }
}
