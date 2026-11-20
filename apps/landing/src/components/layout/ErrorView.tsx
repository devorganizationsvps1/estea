import type { ReactNode } from 'react'
import Btn from '@/components/ui/Btn'
import { contact } from '@/data/content'

/**
 * 404 ve hata sayfalarının gövdesi: başlık, tek cümle, ana sayfa düğmesi, telefon.
 * Alt sayfa ilk ekranıyla aynı dil (linen zemin, brand Bricolage başlık).
 */
export default function ErrorView({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <section aria-labelledby="hata-baslik" className="relative z-10 bg-linen pt-32 pb-24 text-ink sm:pt-40 sm:pb-32">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <h1
          id="hata-baslik"
          className="headline max-w-[14ch] text-[clamp(2.6rem,6vw,5rem)] leading-[0.95] tracking-[-0.03em] text-brand"
        >
          {title}
        </h1>
        <p className="mt-6 max-w-[40ch] text-[clamp(1.15rem,1.5vw,1.35rem)] leading-[1.5] font-medium">{text}</p>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          {action}
          <Btn href="/" variant={action ? 'outline-ink' : 'brand'}>
            Ana sayfaya dön
          </Btn>
        </div>
        <p className="mt-8 text-[1.05rem] leading-[1.6] text-ink/70">
          Yardım için{' '}
          <a href={contact.phone.href} className="font-semibold text-ink underline underline-offset-4">
            {contact.phone.label}
          </a>{' '}
          numarasından bize ulaşabilirsiniz.
        </p>
      </div>
    </section>
  )
}
