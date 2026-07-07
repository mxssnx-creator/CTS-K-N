import { type EntityType, EntityMetadataMap, type ConfigSubType } from "./entity-types"

export interface QueryFilter {
  field: string
  operator: "=" | "!=" | ">" | "<" | ">=" | "<=" | "LIKE" | "IN" | "NOT IN"
  value: any
}

export interface QueryOptions {
  filters?: QueryFilter[]
  orderBy?: { field: string; direction: "ASC" | "DESC" }[]
  limit?: number
  offset?: number
  groupBy?: string[]
}

/**
 * Dynamic Operation Handler for Redis
 * Provides generic CRUD operations for any entity type
 */
export class DynamicOperationHandler {
  private db: any = null

  constructor(dbClient: any) {
    this.db = dbClient
  }

  /**
   * Generic insert operation - Redis mode
   * Usage: insert(EntityTypes.CONFIG, ConfigSubTypes.AUTO_OPTIMAL, data)
   */
  async insert(entityType: EntityType, subType: ConfigSubType | null, data: Record<string, any>): Promise<any> {
    const metadata = EntityMetadataMap[entityType]
    const tableName = metadata.tableName

    console.log(`[v0] Dynamic insert: ${entityType}${subType ? ` (${subType})` : ""} into ${tableName}`)

    const fields = Object.keys(data).filter((key) => metadata.fields.includes(key))
    
    // Store in Redis with pattern: tableName:id
    const id = data.id || `${Date.now()}-${Math.random()}`
    const key = `${tableName}:${id}`
    
    const dataWithId = { ...data, id }
    await this.db.set(key, JSON.stringify(dataWithId))
    
    return dataWithId
  }

  /**
   * Generic update operation - Redis mode
   * Usage: update(EntityTypes.POSITION, id, { current_price: 100 })
   */
  async update(entityType: EntityType, id: string | number, updates: Record<string, any>): Promise<any> {
    const metadata = EntityMetadataMap[entityType]
    const tableName = metadata.tableName

    console.log(`[v0] Dynamic update: ${entityType} (id=${id}) in ${tableName}`)

    // Get existing data
    const key = `${tableName}:${id}`
    const existing = await this.db.get(key)
    const data = existing ? JSON.parse(existing) : {}

    // Merge updates
    const updated = {
      ...data,
      ...updates,
      id,
      updated_at: new Date().toISOString(),
    }

    // Save back
    await this.db.set(key, JSON.stringify(updated))
    return updated
  }

  /**
   * Generic query operation - Redis mode
   * Usage: query(EntityTypes.POSITION, { filters: [{ field: 'connection_id', operator: '=', value: 'xxx' }] })
   */
  async query(entityType: EntityType, options: QueryOptions = {}): Promise<any[]> {
    const metadata = EntityMetadataMap[entityType]
    const tableName = metadata.tableName

    console.log(`[v0] Dynamic query: ${entityType} from ${tableName}`)

    // Get all keys matching pattern
    const pattern = `${tableName}:*`
    const keys = await this.db.keys(pattern)
    
    const results: any[] = []
    for (const key of keys) {
      const data = await this.db.get(key)
      if (data) {
        results.push(JSON.parse(data))
      }
    }

    // Apply filters
    if (options.filters && options.filters.length > 0) {
      return results.filter((item) => {
        return options.filters!.every((filter) => {
          const value = item[filter.field]
          switch (filter.operator) {
            case "=":
              return value === filter.value
            case "!=":
              return value !== filter.value
            case ">":
              return value > filter.value
            case "<":
              return value < filter.value
            case ">=":
              return value >= filter.value
            case "<=":
              return value <= filter.value
            case "LIKE":
              return String(value).includes(filter.value)
            case "IN":
              return Array.isArray(filter.value) ? filter.value.includes(value) : false
            case "NOT IN":
              return Array.isArray(filter.value) ? !filter.value.includes(value) : true
            default:
              return true
          }
        })
      })
    }

    // Apply sorting
    if (options.orderBy && options.orderBy.length > 0) {
      results.sort((a, b) => {
        for (const order of options.orderBy!) {
          const aVal = a[order.field]
          const bVal = b[order.field]
          const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0
          if (cmp !== 0) {
            return order.direction === "DESC" ? -cmp : cmp
          }
        }
        return 0
      })
    }

    // Apply pagination
    let output = results
    if (options.offset) {
      output = output.slice(options.offset)
    }
    if (options.limit) {
      output = output.slice(0, options.limit)
    }

    return output
  }

  /**
   * Generic delete operation - Redis mode
   * Usage: delete(EntityTypes.POSITION, id)
   */
  async delete(entityType: EntityType, id: string | number): Promise<void> {
    const metadata = EntityMetadataMap[entityType]
    const tableName = metadata.tableName
    const key = `${tableName}:${id}`

    console.log(`[v0] Dynamic delete: ${entityType} (id=${id}) from ${tableName}`)

    await this.db.del(key)
  }

  /**
   * Generic batch insert operation - Redis mode
   * Usage: batchInsert(EntityTypes.POSITION, [data1, data2, data3])
   */
  async batchInsert(entityType: EntityType, dataArray: Record<string, any>[]): Promise<void> {
    if (dataArray.length === 0) return

    const metadata = EntityMetadataMap[entityType]
    const tableName = metadata.tableName

    console.log(`[v0] Dynamic batch insert: ${dataArray.length} records into ${entityType} (${tableName})`)

    for (const data of dataArray) {
      const id = data.id || `${Date.now()}-${Math.random()}`
      const key = `${tableName}:${id}`
      await this.db.set(key, JSON.stringify({ ...data, id }))
    }
  }

  /**
   * Generic batch update operation - Redis mode
   * Usage: batchUpdate(EntityTypes.POSITION, [{ id: '1', data: { price: 100 } }])
   */
  async batchUpdate(
    entityType: EntityType,
    updates: Array<{ id: string | number; data: Record<string, any> }>,
  ): Promise<void> {
    if (updates.length === 0) return

    const metadata = EntityMetadataMap[entityType]
    const tableName = metadata.tableName

    console.log(`[v0] Dynamic batch update: ${updates.length} records in ${entityType} (${tableName})`)

    for (const { id, data } of updates) {
      const key = `${tableName}:${id}`
      const existing = await this.db.get(key)
      const current = existing ? JSON.parse(existing) : {}
      const updated = {
        ...current,
        ...data,
        id,
        updated_at: new Date().toISOString(),
      }
      await this.db.set(key, JSON.stringify(updated))
    }
  }

  /**
   * Generic count operation - Redis mode
   * Usage: count(EntityTypes.POSITION, { filters: [...] })
   */
  async count(entityType: EntityType, options: QueryOptions = {}): Promise<number> {
    const results = await this.query(entityType, options)
    return results.length
  }
}
