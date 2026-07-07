import { NextResponse } from "next/server"

/**
 * Standardized API response utilities
 */

export interface ApiResponseOptions {
  status?: number
  headers?: Record<string, string>
}

/**
 * Create a success response
 */
export function successResponse(data: any, options: ApiResponseOptions = {}): NextResponse {
  const { status = 200, headers = {} } = options

  return NextResponse.json(
    {
      success: true,
      data,
      timestamp: new Date().toISOString(),
    },
    {
      status,
      headers,
    },
  )
}

/**
 * Create an error response
 */
export function errorResponse(
  message: string,
  options: ApiResponseOptions & { code?: string; details?: any } = {},
): NextResponse {
  const { status = 500, headers = {}, code, details } = options

  return NextResponse.json(
    {
      success: false,
      error: {
        message,
        code: code || `ERROR_${status}`,
        details,
      },
      timestamp: new Date().toISOString(),
    },
    {
      status,
      headers,
    },
  )
}

/**
 * Create a validation error response
 */
export function validationError(errors: Record<string, string[]>, options: ApiResponseOptions = {}): NextResponse {
  return errorResponse("Validation failed", {
    ...options,
    status: 400,
    code: "VALIDATION_ERROR",
    details: errors,
  })
}

/**
 * Create a not found response
 */
export function notFoundResponse(resource: string, options: ApiResponseOptions = {}): NextResponse {
  return errorResponse(`${resource} not found`, {
    ...options,
    status: 404,
    code: "NOT_FOUND",
  })
}

/**
 * Create an unauthorized response
 */
export function unauthorizedResponse(message = "Unauthorized", options: ApiResponseOptions = {}): NextResponse {
  return errorResponse(message, {
    ...options,
    status: 401,
    code: "UNAUTHORIZED",
  })
}
