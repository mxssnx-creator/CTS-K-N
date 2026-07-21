import { Head, Html, Main, NextScript } from "next/document"

/**
 * Keep a concrete Pages Router document in the build graph even though the
 * application itself uses the App Router. Next still loads /_document while
 * collecting fallback page data. On overlay/provider filesystems its inferred
 * built-in entry can occasionally be absent from the server compiler output,
 * which makes an otherwise valid OpenNext build fail with PageNotFoundError.
 */
export default function Document() {
  return (
    <Html lang="en">
      <Head />
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
