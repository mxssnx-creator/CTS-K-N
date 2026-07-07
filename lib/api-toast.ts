// This creates a response header that the client can read to show toasts

export type ToastMessage = {
  type: "success" | "error" | "info" | "warning"
  message: string
  description?: string
}

export function createToastResponse(data: any, toast: ToastMessage, status = 200): Response {
  const response = Response.json(data, { status })
  response.headers.set("X-Toast-Message", JSON.stringify(toast))
  return response
}

export function successResponse(data: any, message: string, description?: string) {
  return createToastResponse(data, { type: "success", message, description }, 200)
}

export function errorResponse(error: string, message: string, description?: string, status = 400) {
  return createToastResponse({ error }, { type: "error", message, description }, status)
}

export function extractToastFromResponse(response: Response): ToastMessage | null {
  const toastHeader = response.headers.get("X-Toast-Message")
  if (toastHeader) {
    try {
      return JSON.parse(toastHeader)
    } catch {
      return null
    }
  }
  return null
}
