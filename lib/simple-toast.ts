import { toast as sonnerToast } from "sonner"
import type { ExternalToast } from "sonner"

export const toast = {
  success: (message: string, data?: ExternalToast) => {
    console.log(`✅ SUCCESS: ${message}`)
    sonnerToast.success(message, data)
  },
  info: (message: string, data?: ExternalToast) => {
    console.log(`ℹ️ INFO: ${message}`)
    sonnerToast.info(message, data)
  },
  warning: (message: string, data?: ExternalToast) => {
    console.log(`⚠️ WARNING: ${message}`)
    sonnerToast.warning(message, data)
  },
  error: (message: string, data?: ExternalToast) => {
    console.log(`❌ ERROR: ${message}`)
    sonnerToast.error(message, data)
  },
}
