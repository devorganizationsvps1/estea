import type { Metadata } from "next"
import { ErrorState } from "@/components/ErrorState"

export const metadata: Metadata = {
  title: "Sayfa bulunamadı",
  robots: { index: false },
}

export default function NotFound() {
  return (
    <ErrorState
      title="Aradığınız sayfa burada değil"
      text="Bağlantı eskimiş ya da sayfa kaldırılmış olabilir. Ana sayfadan ya da ürünlerden devam edebilirsiniz."
    />
  )
}
