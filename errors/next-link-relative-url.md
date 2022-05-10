# Relative Path in `next/link` component's `href` prop

#### Why This Error Occurred

Use a relative path (starts with a `.`) in `next/link` component's `href` prop is not supported by Next.js.

For example, non of the links will work:

```js
import Link from 'next/link'

export default function Home() {
  return (
    <>
      <Link href="./about">
        <a>To About</a>
      </Link>
      <Link href="../home">
        <a>To Home</a>
      </Link>
      <Link href="../../blog">
        <a>To Blog</a>
      </Link>
    </>
  )
}
```

#### Possible Ways to Fix It

Make sure only use absolute paths (shouldn't starts with a `.`) in `next/link` component's `href` prop.
