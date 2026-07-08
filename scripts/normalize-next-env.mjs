#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const file = 'next-env.d.ts'
if (!existsSync(file)) process.exit(0)

const desired = `/// <reference types="next" />
/// <reference types="next/image-types/global" />
/// <reference path="./.next/types/routes.d.ts" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`

const current = readFileSync(file, 'utf8')
if (current !== desired) {
  writeFileSync(file, desired)
  console.log('[next-env] normalized next-env.d.ts route types reference to .next')
}
