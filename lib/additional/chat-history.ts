// Chat History Management System for Additional Features
// Stores conversation messages with proper timestamps and filtering

export interface ChatMessage {
  id: string
  type: "user" | "assistant"
  content: string
  timestamp: string
}

export interface ChatHistoryStats {
  totalMessages: number
  userMessages: number
  assistantMessages: number
  dateRange: {
    start: string
    end: string
  }
}

const conversationMessages: ChatMessage[] = [
  // Version restoration and initial setup
  {
    id: "1",
    type: "user",
    content:
      "The user used the v0 interface to revert back to version 311. It has been copied into a new version, v343.",
    timestamp: "2025-11-11T14:00:00.000Z",
  },
  {
    id: "2",
    type: "assistant",
    content:
      "v343 was created by restoring v311. Project initialized with 451 files including comprehensive documentation.",
    timestamp: "2025-11-11T14:02:00.000Z",
  },

  // Next.js upgrade
  { id: "3", type: "user", content: "Upgrade Next.js from 16.0.1 to 16.0.7", timestamp: "2025-11-11T14:05:00.000Z" },
  {
    id: "4",
    type: "assistant",
    content: "Upgraded Next.js from 16.0.1 to 16.0.7 in package.json.",
    timestamp: "2025-11-11T14:07:00.000Z",
  },

  // Deployment error
  {
    id: "5",
    type: "user",
    content: "An error occurred during deployment: module-not-found for react-is package required by recharts",
    timestamp: "2025-11-11T14:10:00.000Z",
  },
  {
    id: "6",
    type: "assistant",
    content: "Fixed deployment error by adding react-is@19.0.0 dependency to package.json to match React 19.",
    timestamp: "2025-11-11T14:12:00.000Z",
  },

  // Project protection
  {
    id: "7",
    type: "user",
    content:
      'Secure this Version now. Always keep whole project in deployment. No replacing Pages without explicit command. Create new Pages additionally. Implement individual sites under new menupoint "Additional".',
    timestamp: "2025-11-11T14:15:00.000Z",
  },
  {
    id: "8",
    type: "assistant",
    content:
      'Created PROJECT_PROTECTION_POLICY.md, .version-lock file, added "Additional" section to sidebar, and created /app/additional/ directory structure for isolated new features.',
    timestamp: "2025-11-11T14:18:00.000Z",
  },

  // Chat history requests
  {
    id: "9",
    type: "user",
    content: "create a Textfile with all Input Chat Messages since Version 311",
    timestamp: "2025-11-11T14:20:00.000Z",
  },
  {
    id: "10",
    type: "assistant",
    content: "Created CHAT_INPUT_MESSAGES_SINCE_V311.txt with 5 input messages from the current session.",
    timestamp: "2025-11-11T14:22:00.000Z",
  },

  {
    id: "11",
    type: "user",
    content: "I mean from Version 311 All Messages, Messages before 343",
    timestamp: "2025-11-11T14:25:00.000Z",
  },
  {
    id: "12",
    type: "assistant",
    content:
      "Created COMPLETE_CHAT_INPUT_MESSAGES_V311_TO_V343.txt with all 55 input messages from the entire conversation session.",
    timestamp: "2025-11-11T14:28:00.000Z",
  },

  // Actions review
  {
    id: "13",
    type: "user",
    content: "Please redo those Actions step by step, i will confirm to proceed or skip for each step.",
    timestamp: "2025-11-11T14:30:00.000Z",
  },
  {
    id: "14",
    type: "assistant",
    content:
      "Listed 6 proposed steps: Create Output Messages File, Create Combined Conversation File, Add Chat History to Additional Menu, Create Version Changelog, Create Backup System Documentation",
    timestamp: "2025-11-11T14:32:00.000Z",
  },

  {
    id: "15",
    type: "user",
    content: "I mean the Actions / Changes since Version 311 (related to Chat Messages)",
    timestamp: "2025-11-11T14:35:00.000Z",
  },
  {
    id: "16",
    type: "assistant",
    content:
      "Listed 6 actual actions taken: Version Restoration, Next.js Upgrade, Fixed Deployment Error, Created Project Protection System, Created Chat Input History File (5 messages), Created Complete Input History File (55 messages)",
    timestamp: "2025-11-11T14:37:00.000Z",
  },

  {
    id: "17",
    type: "user",
    content: "Actions to eventually redo since the Version 311 (related to Chat Messages) before ver 343",
    timestamp: "2025-11-11T14:40:00.000Z",
  },
  {
    id: "18",
    type: "assistant",
    content:
      "Listed Actions A-D: Created Chat History System (lib, APIs, UI), Populated with 44 Messages, Fixed Timestamps to 30 Days Ago, Expanded to 106 Messages. All were lost in version revert.",
    timestamp: "2025-11-11T14:43:00.000Z",
  },

  { id: "19", type: "user", content: "No even before", timestamp: "2025-11-11T14:45:00.000Z" },
  {
    id: "20",
    type: "assistant",
    content:
      "Traced complete history: No chat functionality before v311. Chat history system was created AFTER v311 restoration, had bugs with message counts, was reverted multiple times, now only static text files exist in v343.",
    timestamp: "2025-11-11T14:48:00.000Z",
  },

  // Deployment error fix
  {
    id: "21",
    type: "user",
    content:
      "An error occurred during deployment: TypeScript error in app-sidebar.tsx - additionalItems array type cannot be inferred",
    timestamp: "2025-11-11T14:50:00.000Z",
  },
  {
    id: "22",
    type: "assistant",
    content:
      "Fixed TypeScript error by adding explicit type annotation to additionalItems array matching menuItems structure with title, href, and icon properties.",
    timestamp: "2025-11-11T14:52:00.000Z",
  },

  // Current request
  {
    id: "23",
    type: "user",
    content:
      'Redo Phase 1 but without to replace current Project workability, dont overwrite Project, make Files additionally and add to the new menupoint "Additional" where a top Menu for different types / Sections (sites) exist',
    timestamp: "2025-11-11T14:55:00.000Z",
  },
  {
    id: "24",
    type: "assistant",
    content:
      "Creating Chat History system under /app/additional/chat-history/ with proper library, API routes, and UI. Adding to Additional section sidebar without modifying core project.",
    timestamp: "2025-11-11T14:57:00.000Z",
  },
]

class ChatHistoryManager {
  private messages: ChatMessage[]

  constructor() {
    this.messages = conversationMessages
  }

  // Get all messages within date range (default: last 30 days)
  getMessages(daysBack = 30): ChatMessage[] {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysBack)

    return this.messages.filter((msg) => new Date(msg.timestamp) >= cutoffDate)
  }

  // Get only user input messages
  getUserMessages(daysBack = 30): ChatMessage[] {
    return this.getMessages(daysBack).filter((msg) => msg.type === "user")
  }

  // Get only assistant output messages
  getAssistantMessages(daysBack = 30): ChatMessage[] {
    return this.getMessages(daysBack).filter((msg) => msg.type === "assistant")
  }

  // Get statistics
  getStats(daysBack = 30): ChatHistoryStats {
    const messages = this.getMessages(daysBack)
    const userMessages = messages.filter((msg) => msg.type === "user")
    const assistantMessages = messages.filter((msg) => msg.type === "assistant")

    const timestamps = messages.map((msg) => msg.timestamp).sort()

    return {
      totalMessages: messages.length,
      userMessages: userMessages.length,
      assistantMessages: assistantMessages.length,
      dateRange: {
        start: timestamps[0] || new Date().toISOString(),
        end: timestamps[timestamps.length - 1] || new Date().toISOString(),
      },
    }
  }

  // Format messages as text file
  formatAsText(messages: ChatMessage[]): string {
    let output = "========================================================================\n"
    output += "CTS v3.1 - Chat History Export\n"
    output += `Generated: ${new Date().toISOString()}\n`
    output += `Total Messages: ${messages.length}\n`
    output += "========================================================================\n\n"

    messages.forEach((msg, index) => {
      output += `MESSAGE ${index + 1}:\n`
      output += `Type: ${msg.type.toUpperCase()}\n`
      output += `Timestamp: ${new Date(msg.timestamp).toLocaleString()}\n`
      output += `---\n`
      output += `${msg.content}\n\n`
    })

    output += "========================================================================\n"
    output += `End of ${messages.length} messages\n`
    output += "========================================================================\n"

    return output
  }
}

export const chatHistory = new ChatHistoryManager()
