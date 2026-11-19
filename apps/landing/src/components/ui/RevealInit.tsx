'use client'

import { useEffect } from 'react'

/** Adds `.is-in` to every `[data-reveal]` element once it enters the viewport. */
export default function RevealInit() {
  useEffect(() => {
    const nodes = document.querySelectorAll<HTMLElement>('[data-reveal]')
    if (!nodes.length) return

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in')
            io.unobserve(entry.target)
          }
        }
      },
      // Eşik oran değil piksel: telefonda 1000 px'lik bir blok %15'ini beklerse ekranın üçte biri boş kalır.
      { rootMargin: '0px 0px -64px 0px', threshold: 0 },
    )

    nodes.forEach((node) => io.observe(node))
    return () => io.disconnect()
  }, [])

  return null
}
