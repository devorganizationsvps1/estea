"use client"

import { useEffect } from "react"
import { ErrorState } from "@/components/ErrorState"

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <ErrorState
      title="Bir şeyler ters gitti"
      text="Sayfa şu an açılamadı. Birkaç saniye sonra tekrar deneyebilirsiniz."
      action={
        <button type="button" className="cart-cta cart-cta--ink" onClick={() => reset()}>
          Tekrar dene
        </button>
      }
    />
  )
}
