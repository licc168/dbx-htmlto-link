(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else {
    root.HtmlToLinkTable = api
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_CELL_CHARS = 2000
  const MAX_MARKDOWN_BYTES = 2_000_000

  function cellText(value) {
    if (value === null || value === undefined) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value)
    }
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  function clip(value) {
    const text = cellText(value).replace(/\r\n|\r|\n/g, ' ')
    if (text.length <= MAX_CELL_CHARS) return text
    return text.slice(0, MAX_CELL_CHARS) + '…'
  }

  function markdownCell(value) {
    return clip(value).replace(/\|/g, '\\|')
  }

  function columnName(column, index, fallback) {
    const raw = typeof column === 'string' ? column : column && column.name
    const name = typeof raw === 'string' ? raw.replace(/\r\n|\r|\n/g, ' ').trim() : ''
    return name || fallback(index)
  }

  function uniqueNames(columns, fallback) {
    const seen = new Map()
    return columns.map((column, index) => {
      const base = columnName(column, index, fallback)
      const count = seen.get(base) || 0
      seen.set(base, count + 1)
      return count === 0 ? base : base + '_' + (count + 1)
    })
  }

  function rowValues(row, names) {
    if (Array.isArray(row)) return names.map((_, index) => row[index])
    if (row && typeof row === 'object') return names.map((name) => row[name])
    return names.map(() => row)
  }

  function sqlFence(sql) {
    const matches = String(sql).match(/`+/g) || []
    const width = matches.reduce((longest, item) => Math.max(longest, item.length), 2) + 1
    const fence = '`'.repeat(width)
    return fence + 'sql\n' + String(sql).replace(/\s+$/, '') + '\n' + fence
  }

  function quoteIdent(name) {
    const text = String(name)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return text
    return '"' + text.replace(/"/g, '""') + '"'
  }

  function sqlLiteral(value) {
    return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
  }

  function normalizeDbType(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  }

  const MYSQL_TYPES = new Set(['mysql', 'mariadb', 'tidb', 'oceanbase', 'doris', 'starrocks', 'selectdb', 'tdsql'])
  const POSTGRES_TYPES = new Set(['postgres', 'postgresql', 'kingbase', 'kingbasees', 'opengauss', 'gaussdb', 'vastbase', 'highgo', 'greenplum'])
  const SQLSERVER_TYPES = new Set(['sqlserver', 'mssql', 'azuresql'])

  function dialectFamily(value) {
    const id = normalizeDbType(value)
    if (MYSQL_TYPES.has(id)) return 'mysql'
    if (POSTGRES_TYPES.has(id)) return 'postgres'
    if (SQLSERVER_TYPES.has(id)) return 'sqlserver'
    return ''
  }

  function schemaNames(input) {
    const source = input && typeof input === 'object' ? input : {}
    const database = typeof source.database === 'string' ? source.database.trim() : ''
    const schema = typeof source.schema === 'string' ? source.schema.trim() : ''
    if (database.includes('\0') || schema.includes('\0')) return null
    return { database, schema }
  }

  function catalogTarget(input) {
    const source = input && typeof input === 'object' ? input : {}
    const table = typeof source.table === 'string' ? source.table.trim() : ''
    const names = schemaNames(source)
    if (!table || table.includes('\0') || !names) return null
    const family = dialectFamily(source.dbType)
    if (!family) return null
    const { database, schema } = names
    const tableSchema = family === 'mysql' ? (database || schema) : family === 'postgres' ? (schema || 'public') : (schema || 'dbo')
    if (!tableSchema) return null
    return { table, tableSchema, family }
  }

  function indexCatalogQuery(input) {
    const target = catalogTarget(input)
    if (!target) return null
    const { table, tableSchema, family } = target
    if (family === 'mysql') {
      return [
        'SELECT INDEX_NAME AS index_name,',
        'CASE WHEN NON_UNIQUE = 0 THEN 1 ELSE 0 END AS is_unique,',
        "CASE WHEN INDEX_NAME = 'PRIMARY' THEN 1 ELSE 0 END AS is_primary,",
        'SEQ_IN_INDEX AS seq_in_index,',
        'COLUMN_NAME AS column_name,',
        'INDEX_TYPE AS index_type',
        'FROM information_schema.STATISTICS',
        'WHERE TABLE_SCHEMA = ' + sqlLiteral(tableSchema) + ' AND TABLE_NAME = ' + sqlLiteral(table),
        'ORDER BY INDEX_NAME, SEQ_IN_INDEX',
      ].join(' ')
    }
    if (family === 'postgres') {
      return [
        'SELECT i.relname AS index_name,',
        'CASE WHEN ix.indisunique THEN 1 ELSE 0 END AS is_unique,',
        'CASE WHEN ix.indisprimary THEN 1 ELSE 0 END AS is_primary,',
        'k.seq_in_index AS seq_in_index,',
        'a.attname AS column_name,',
        'am.amname AS index_type',
        'FROM pg_class t',
        'JOIN pg_namespace n ON n.oid = t.relnamespace',
        'JOIN pg_index ix ON ix.indrelid = t.oid',
        'JOIN pg_class i ON i.oid = ix.indexrelid',
        'JOIN pg_am am ON am.oid = i.relam',
        'JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, seq_in_index) ON k.attnum > 0',
        'JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum',
        'WHERE n.nspname = ' + sqlLiteral(tableSchema) + ' AND t.relname = ' + sqlLiteral(table),
        'ORDER BY i.relname, k.seq_in_index',
      ].join(' ')
    }
    return [
        'SELECT i.name AS index_name,',
        'CASE WHEN i.is_unique = 1 THEN 1 ELSE 0 END AS is_unique,',
        'CASE WHEN i.is_primary_key = 1 THEN 1 ELSE 0 END AS is_primary,',
        'ic.key_ordinal AS seq_in_index,',
        'c.name AS column_name,',
        'i.type_desc AS index_type',
        'FROM sys.indexes i',
        'INNER JOIN sys.tables t ON t.object_id = i.object_id',
        'INNER JOIN sys.schemas s ON s.schema_id = t.schema_id',
        'INNER JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0',
        'INNER JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id',
        'WHERE s.name = ' + sqlLiteral(tableSchema) + ' AND t.name = ' + sqlLiteral(table) + ' AND i.type > 0 AND i.is_hypothetical = 0',
        'ORDER BY i.name, ic.key_ordinal',
      ].join(' ')
  }

  function tableListQuery(input) {
    const names = schemaNames(input)
    if (!names) return null
    const { database, schema } = names
    const family = dialectFamily(input && input.dbType)
    if (family === 'mysql') {
      const tableSchema = database || schema
      if (!tableSchema) return null
      return [
        'SELECT TABLE_NAME AS table_name, TABLE_COMMENT AS table_comment',
        'FROM information_schema.TABLES',
        'WHERE TABLE_SCHEMA = ' + sqlLiteral(tableSchema) + " AND TABLE_TYPE = 'BASE TABLE'",
        'ORDER BY TABLE_NAME',
      ].join(' ')
    }
    if (family === 'postgres') {
      const tableSchema = schema || 'public'
      return [
        "SELECT c.relname AS table_name, COALESCE(pg_catalog.obj_description(c.oid, 'pg_class'), '') AS table_comment",
        'FROM pg_class c',
        'JOIN pg_namespace n ON n.oid = c.relnamespace',
        'WHERE n.nspname = ' + sqlLiteral(tableSchema) + " AND c.relkind = 'r'",
        'ORDER BY c.relname',
      ].join(' ')
    }
    if (family === 'sqlserver') {
      const tableSchema = schema || 'dbo'
      return [
        'SELECT t.name AS table_name, CAST(ep.value AS nvarchar(400)) AS table_comment',
        'FROM sys.tables t',
        'INNER JOIN sys.schemas s ON s.schema_id = t.schema_id',
        'LEFT JOIN sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = ' + sqlLiteral('MS_Description'),
        'WHERE s.name = ' + sqlLiteral(tableSchema),
        'ORDER BY t.name',
      ].join(' ')
    }
    return null
  }

  function columnCommentQuery(input) {
    const target = catalogTarget(input)
    if (!target) return null
    const { table, tableSchema, family } = target
    if (family === 'mysql') {
      return [
        'SELECT COLUMN_NAME AS column_name, COLUMN_COMMENT AS column_comment',
        'FROM information_schema.COLUMNS',
        'WHERE TABLE_SCHEMA = ' + sqlLiteral(tableSchema) + ' AND TABLE_NAME = ' + sqlLiteral(table),
        'ORDER BY ORDINAL_POSITION',
      ].join(' ')
    }
    if (family === 'postgres') {
      return [
        'SELECT a.attname AS column_name,',
        "COALESCE(pg_catalog.col_description(a.attrelid, a.attnum), '') AS column_comment",
        'FROM pg_attribute a',
        'JOIN pg_class c ON c.oid = a.attrelid',
        'JOIN pg_namespace n ON n.oid = c.relnamespace',
        'WHERE n.nspname = ' + sqlLiteral(tableSchema) + ' AND c.relname = ' + sqlLiteral(table),
        'AND a.attnum > 0 AND NOT a.attisdropped',
        'ORDER BY a.attnum',
      ].join(' ')
    }
    return [
      'SELECT c.name AS column_name, CAST(ep.value AS nvarchar(400)) AS column_comment',
      'FROM sys.columns c',
      'INNER JOIN sys.tables t ON t.object_id = c.object_id',
      'INNER JOIN sys.schemas s ON s.schema_id = t.schema_id',
      'LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = ' + sqlLiteral('MS_Description'),
      'WHERE s.name = ' + sqlLiteral(tableSchema) + ' AND t.name = ' + sqlLiteral(table),
      'ORDER BY c.column_id',
    ].join(' ')
  }

  function foreignKeyQuery(input) {
    const target = catalogTarget(input)
    if (!target) return null
    const { table, tableSchema, family } = target
    if (family === 'mysql') {
      return [
        'SELECT k.CONSTRAINT_NAME AS constraint_name,',
        'k.COLUMN_NAME AS column_name,',
        'k.ORDINAL_POSITION AS ordinal_position,',
        'k.REFERENCED_TABLE_SCHEMA AS referenced_schema,',
        'k.REFERENCED_TABLE_NAME AS referenced_table,',
        'k.REFERENCED_COLUMN_NAME AS referenced_column,',
        'r.UPDATE_RULE AS update_rule,',
        'r.DELETE_RULE AS delete_rule',
        'FROM information_schema.KEY_COLUMN_USAGE k',
        'INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS r',
        'ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME',
        'WHERE k.TABLE_SCHEMA = ' + sqlLiteral(tableSchema) + ' AND k.TABLE_NAME = ' + sqlLiteral(table),
        'AND k.REFERENCED_TABLE_NAME IS NOT NULL',
        'ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION',
      ].join(' ')
    }
    if (family === 'postgres') {
      return [
        'SELECT con.conname AS constraint_name,',
        'src.attname AS column_name,',
        'k.ord AS ordinal_position,',
        'rn.nspname AS referenced_schema,',
        'rel.relname AS referenced_table,',
        'dst.attname AS referenced_column,',
        "CASE con.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE '' END AS update_rule,",
        "CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE '' END AS delete_rule",
        'FROM pg_constraint con',
        'JOIN pg_class c ON c.oid = con.conrelid',
        'JOIN pg_namespace n ON n.oid = c.relnamespace',
        'JOIN pg_class rel ON rel.oid = con.confrelid',
        'JOIN pg_namespace rn ON rn.oid = rel.relnamespace',
        'JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(src_att, dst_att, ord) ON true',
        'JOIN pg_attribute src ON src.attrelid = con.conrelid AND src.attnum = k.src_att',
        'JOIN pg_attribute dst ON dst.attrelid = con.confrelid AND dst.attnum = k.dst_att',
        "WHERE con.contype = 'f' AND n.nspname = " + sqlLiteral(tableSchema) + ' AND c.relname = ' + sqlLiteral(table),
        'ORDER BY con.conname, k.ord',
      ].join(' ')
    }
    return [
      'SELECT fk.name AS constraint_name,',
      'pc.name AS column_name,',
      'fkc.constraint_column_id AS ordinal_position,',
      'rs.name AS referenced_schema,',
      'rt.name AS referenced_table,',
      'rc.name AS referenced_column,',
      'fk.update_referential_action_desc AS update_rule,',
      'fk.delete_referential_action_desc AS delete_rule',
      'FROM sys.foreign_keys fk',
      'INNER JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id',
      'INNER JOIN sys.tables pt ON pt.object_id = fk.parent_object_id',
      'INNER JOIN sys.schemas ps ON ps.schema_id = pt.schema_id',
      'INNER JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id',
      'INNER JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id',
      'INNER JOIN sys.schemas rs ON rs.schema_id = rt.schema_id',
      'INNER JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id',
      'WHERE ps.name = ' + sqlLiteral(tableSchema) + ' AND pt.name = ' + sqlLiteral(table),
      'ORDER BY fk.name, fkc.constraint_column_id',
    ].join(' ')
  }

  function rowCell(row, labels, name) {
    if (Array.isArray(row)) {
      const index = labels.indexOf(name)
      return index < 0 ? undefined : row[index]
    }
    if (row && typeof row === 'object') {
      if (Object.prototype.hasOwnProperty.call(row, name)) return row[name]
      const key = Object.keys(row).find((item) => item.toLowerCase() === name)
      return key == null ? undefined : row[key]
    }
    return undefined
  }

  function parseTableList(input) {
    const source = input && typeof input === 'object' ? input : {}
    const columns = Array.isArray(source.columns) ? source.columns : []
    const labels = columns.map((column) => {
      const raw = typeof column === 'string' ? column : column && column.name
      return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    })
    const seen = new Set()
    const tables = []
    for (const row of Array.isArray(source.rows) ? source.rows : []) {
      const name = String(rowCell(row, labels, 'table_name') ?? '').replace(/\r\n|\r|\n/g, ' ').trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      const comment = String(rowCell(row, labels, 'table_comment') ?? '').replace(/\r\n|\r|\n/g, ' ').trim()
      tables.push({ name, comment })
    }
    return tables
  }

  function flagOn(value) {
    if (value === true || value === 1) return true
    if (typeof value === 'string') {
      const text = value.trim().toLowerCase()
      return text === '1' || text === 'true' || text === 't' || text === 'yes'
    }
    return false
  }

  function parseIndexRows(input) {
    const source = input && typeof input === 'object' ? input : {}
    const columns = Array.isArray(source.columns) ? source.columns : []
    const labels = columns.map((column) => {
      const raw = typeof column === 'string' ? column : column && column.name
      return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    })
    const groups = new Map()
    for (const row of Array.isArray(source.rows) ? source.rows : []) {
      const name = String(rowCell(row, labels, 'index_name') ?? '').replace(/\r\n|\r|\n/g, ' ').trim()
      const column = String(rowCell(row, labels, 'column_name') ?? '').replace(/\r\n|\r|\n/g, ' ').trim()
      if (!name || !column) continue
      let group = groups.get(name)
      if (!group) {
        group = {
          name,
          unique: flagOn(rowCell(row, labels, 'is_unique')),
          primary: flagOn(rowCell(row, labels, 'is_primary')) || name.toUpperCase() === 'PRIMARY',
          type: String(rowCell(row, labels, 'index_type') ?? '').replace(/\r\n|\r|\n/g, ' ').trim(),
          parts: [],
        }
        groups.set(name, group)
      }
      const seq = Number(rowCell(row, labels, 'seq_in_index'))
      group.parts.push({ column, seq: Number.isFinite(seq) ? seq : group.parts.length + 1 })
    }
    return Array.from(groups.values()).map((group) => {
      const seen = new Set()
      const columns = group.parts
        .slice()
        .sort((left, right) => left.seq - right.seq || left.column.localeCompare(right.column))
        .map((part) => part.column)
        .filter((column) => {
          if (seen.has(column)) return false
          seen.add(column)
          return true
        })
      return {
        name: group.name,
        unique: group.unique,
        primary: group.primary,
        type: group.type,
        columns,
      }
    })
  }

  function columnLabels(input) {
    const source = input && typeof input === 'object' ? input : {}
    const columns = Array.isArray(source.columns) ? source.columns : []
    return columns.map((column) => {
      const raw = typeof column === 'string' ? column : column && column.name
      return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    })
  }

  function oneLine(value) {
    return String(value ?? '').replace(/\r\n|\r|\n/g, ' ').trim()
  }

  function ruleText(value) {
    return oneLine(value).replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  }

  function referentialAction(rule) {
    const text = ruleText(rule).toUpperCase()
    if (text === 'CASCADE' || text === 'SET NULL' || text === 'SET DEFAULT') return text
    return ''
  }

  function parseColumnComments(input) {
    const labels = columnLabels(input)
    const rows = Array.isArray(input && input.rows) ? input.rows : []
    const seen = new Set()
    const comments = []
    for (const row of rows) {
      const name = oneLine(rowCell(row, labels, 'column_name'))
      const comment = clip(rowCell(row, labels, 'column_comment')).trim()
      if (!name || !comment || seen.has(name)) continue
      seen.add(name)
      comments.push({ name, comment })
    }
    return comments
  }

  function parseForeignKeys(input) {
    const labels = columnLabels(input)
    const rows = Array.isArray(input && input.rows) ? input.rows : []
    const groups = new Map()
    for (const row of rows) {
      const name = oneLine(rowCell(row, labels, 'constraint_name'))
      const column = oneLine(rowCell(row, labels, 'column_name'))
      const referencedTable = oneLine(rowCell(row, labels, 'referenced_table'))
      const referencedColumn = oneLine(rowCell(row, labels, 'referenced_column'))
      if (!name || !column || !referencedTable || !referencedColumn) continue
      let group = groups.get(name)
      if (!group) {
        group = {
          name,
          referencedSchema: oneLine(rowCell(row, labels, 'referenced_schema')),
          referencedTable,
          updateRule: ruleText(rowCell(row, labels, 'update_rule')),
          deleteRule: ruleText(rowCell(row, labels, 'delete_rule')),
          parts: [],
        }
        groups.set(name, group)
      }
      const seq = Number(rowCell(row, labels, 'ordinal_position'))
      group.parts.push({
        column,
        referencedColumn,
        seq: Number.isFinite(seq) ? seq : group.parts.length + 1,
      })
    }
    return Array.from(groups.values()).map((group) => {
      const seen = new Set()
      const columns = []
      const referencedColumns = []
      const parts = group.parts.slice().sort((left, right) => left.seq - right.seq || left.column.localeCompare(right.column))
      for (const part of parts) {
        const key = part.column + '\0' + part.referencedColumn
        if (seen.has(key)) continue
        seen.add(key)
        columns.push(part.column)
        referencedColumns.push(part.referencedColumn)
      }
      return {
        name: group.name,
        columns,
        referencedSchema: group.referencedSchema,
        referencedTable: group.referencedTable,
        referencedColumns,
        updateRule: group.updateRule,
        deleteRule: group.deleteRule,
      }
    })
  }

  function foreignKeyReference(key) {
    if (!key) return ''
    const table = [key.referencedSchema, key.referencedTable]
      .filter((item) => item != null && String(item).trim() !== '')
      .map((item) => String(item).trim())
      .join('.')
    const cols = Array.isArray(key.referencedColumns) ? key.referencedColumns.filter(Boolean).join(', ') : ''
    if (!table) return cols
    return cols ? table + ' (' + cols + ')' : table
  }

  function indexKindLabel(index, labels) {
    const names = labels || {}
    if (index.primary) return names.primary || 'primary key'
    const type = String(index.type || '').toUpperCase()
    if (type === 'FULLTEXT') return names.fulltext || 'fulltext'
    if (type === 'SPATIAL') return names.spatial || 'spatial'
    if (index.unique) return names.unique || 'unique'
    return names.plain || 'index'
  }

  function indexStatements(qualified, indexes) {
    const lines = []
    for (const index of indexes) {
      if (!index || !Array.isArray(index.columns) || index.columns.length === 0) continue
      const cols = index.columns.map(quoteIdent).join(', ')
      if (index.primary) {
        lines.push('ALTER TABLE ' + qualified + ' ADD PRIMARY KEY (' + cols + ');')
        continue
      }
      const type = String(index.type || '').toUpperCase()
      const kind = type === 'FULLTEXT' ? 'FULLTEXT ' : type === 'SPATIAL' ? 'SPATIAL ' : ''
      const unique = index.unique && !kind ? 'UNIQUE ' : ''
      lines.push('CREATE ' + unique + kind + 'INDEX ' + quoteIdent(index.name) + ' ON ' + qualified + ' (' + cols + ');')
    }
    return lines.join('\n')
  }

  function foreignKeyStatements(qualified, keys) {
    const lines = []
    for (const key of keys) {
      if (!key || !Array.isArray(key.columns) || key.columns.length === 0 || !key.referencedTable) continue
      const cols = key.columns.map(quoteIdent).join(', ')
      const refCols = Array.isArray(key.referencedColumns) ? key.referencedColumns.map(quoteIdent).join(', ') : ''
      if (!refCols) continue
      const owner = key.referencedSchema ? quoteIdent(key.referencedSchema) + '.' : ''
      let line = 'ALTER TABLE ' + qualified + ' ADD CONSTRAINT ' + quoteIdent(key.name) + ' FOREIGN KEY (' + cols + ') REFERENCES ' + owner + quoteIdent(key.referencedTable) + ' (' + refCols + ')'
      const onDelete = referentialAction(key.deleteRule)
      const onUpdate = referentialAction(key.updateRule)
      if (onDelete) line += ' ON DELETE ' + onDelete
      if (onUpdate) line += ' ON UPDATE ' + onUpdate
      lines.push(line + ';')
    }
    return lines.join('\n')
  }

  function tableCommentStatement(qualified, comment, dbType) {
    const text = clip(comment).trim()
    if (!text || !qualified) return ''
    const family = dialectFamily(dbType)
    if (family === 'postgres') return 'COMMENT ON TABLE ' + qualified + ' IS ' + sqlLiteral(text) + ';'
    if (family === 'sqlserver') return ''
    return 'ALTER TABLE ' + qualified + ' COMMENT = ' + sqlLiteral(text) + ';'
  }

  function attachColumnComments(columns, comments) {
    if (!Array.isArray(comments) || comments.length === 0) return columns
    const exact = new Map()
    const lower = new Map()
    for (const item of comments) {
      if (!item || !item.comment) continue
      const name = oneLine(item.name)
      if (!name) continue
      if (!exact.has(name)) exact.set(name, item.comment)
      const key = name.toLowerCase()
      if (!lower.has(key)) lower.set(key, item.comment)
    }
    if (exact.size === 0) return columns
    return columns.map((column) => {
      const source = column && typeof column === 'object' ? column : { name: column }
      const raw = typeof column === 'string' ? column : source.name
      const name = typeof raw === 'string' ? raw.trim() : ''
      const own = source.comment != null && oneLine(source.comment) !== '' ? source.comment : ''
      const extra = (name && exact.get(name)) || (name && lower.get(name.toLowerCase())) || ''
      const comment = own || extra
      if (!comment) return column
      return { ...source, comment }
    })
  }

  function describeColumn(column, index, fallback) {
    const source = column && typeof column === 'object' ? column : { name: column }
    const name = columnName(source, index, fallback || ((item) => 'column_' + (item + 1)))
    const dataType = typeof source.dataType === 'string' && source.dataType.trim() ? source.dataType.trim() : 'text'
    let type = dataType
    if (source.length != null && source.length !== '') {
      type += '(' + source.length + ')'
    } else if (source.precision != null && source.precision !== '') {
      type += '(' + source.precision
      if (source.scale != null && source.scale !== '') type += ', ' + source.scale
      type += ')'
    }
    let line = quoteIdent(name) + ' ' + type
    if (source.nullable === false) line += ' NOT NULL'
    const defaultValue = source.default == null ? '' : String(source.default).replace(/\r\n|\r|\n/g, ' ')
    if (defaultValue) line += ' DEFAULT ' + defaultValue
    const comment = clip(source.comment == null ? '' : source.comment).trim()
    if (comment) line += ' COMMENT ' + sqlLiteral(comment)
    return {
      name,
      type,
      nullable: source.nullable,
      defaultValue,
      comment,
      line,
    }
  }

  function finishMarkdown(title, lines) {
    lines.push('')
    const markdown = lines.join('\n')
    const bytes = byteLength(markdown)
    if (bytes > MAX_MARKDOWN_BYTES) {
      const error = new Error('TOO_LARGE')
      error.code = 'TOO_LARGE'
      throw error
    }
    return { markdown, title, bytes }
  }

  function byteLength(value) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length
    return Buffer.byteLength(value)
  }

  function buildShareMarkdown(input) {
    const columns = Array.isArray(input.columns) ? input.columns : []
    if (columns.length === 0) {
      const error = new Error('NO_COLUMNS')
      error.code = 'NO_COLUMNS'
      throw error
    }
    const names = uniqueNames(columns, input.columnFallback || ((index) => 'column_' + (index + 1)))
    const rows = Array.isArray(input.rows) ? input.rows : []
    const lines = []
    const title = String(input.title || 'Query result').replace(/\r\n|\r|\n/g, ' ').trim().slice(0, 128) || 'Query result'
    lines.push('# ' + title, '')
    const summary = input.summary || [input.database, input.schema, rows.length + ' rows'].filter((item) => item !== undefined && item !== null && String(item) !== '').join(' · ')
    lines.push(summary)
    if (input.note) lines.push('', String(input.note))
    lines.push('', '| ' + names.map(markdownCell).join(' | ') + ' |')
    lines.push('| ' + names.map(() => '---').join(' | ') + ' |')
    for (const row of rows) {
      lines.push('| ' + rowValues(row, names).map(markdownCell).join(' | ') + ' |')
    }
    if (input.includeSql && typeof input.sql === 'string' && input.sql.trim()) {
      lines.push('', '## SQL', '', sqlFence(input.sql.trim()))
    }
    const page = finishMarkdown(title, lines)
    return { ...page, rowCount: rows.length, columnCount: names.length }
  }

  function tableTitle(value, fallback) {
    return String(value || fallback || '').replace(/\r\n|\r|\n/g, ' ').trim().slice(0, 128) || String(fallback || '')
  }

  function writeTableSection(lines, input, titlePrefix, subPrefix) {
    const table = String(input.table || '').replace(/\r\n|\r|\n/g, ' ').trim()
    const columns = attachColumnComments(Array.isArray(input.columns) ? input.columns : [], input.columnComments)
    const fallback = input.columnFallback || ((index) => 'column_' + (index + 1))
    const fields = columns.map((column, index) => describeColumn(column, index, fallback))
    const headers = input.headers || { name: 'column', type: 'type', nullable: 'nullable', defaultValue: 'default' }
    const owner = [input.schema, input.database].find((item) => item != null && String(item).trim() !== '')
    const qualified = [owner, table].filter((item) => item != null && String(item).trim() !== '').map(quoteIdent).join('.')
    let ddl = fields.length
      ? 'CREATE TABLE ' + qualified + ' (\n' + fields.map((field) => '  ' + field.line).join(',\n') + '\n);'
      : ''
    const yes = input.yes == null ? 'yes' : String(input.yes)
    const no = input.no == null ? 'no' : String(input.no)
    const tableComment = clip(input.comment || '').trim()
    const note = input.note ? String(input.note) : ''
    if (titlePrefix) lines.push(titlePrefix + tableTitle(input.title, table), '')
    if (input.summary) lines.push(String(input.summary))
    if (note) lines.push('', note)
    if (tableComment && tableComment !== note.replace(/\r\n|\r|\n/g, ' ').trim()) lines.push('', tableComment)
    if (!fields.length) {
      lines.push('', input.emptyColumns || 'No columns.')
      return { ddl: '', rowCount: 0, columnCount: 0 }
    }
    const showComments = fields.some((field) => field.comment)
    const head = [headers.name, headers.type, headers.nullable, headers.defaultValue]
    if (showComments) head.push(headers.comment || 'comment')
    lines.push('', '| ' + head.map(markdownCell).join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |')
    for (const field of fields) {
      const nullable = field.nullable === false ? no : field.nullable === true ? yes : ''
      const cells = [field.name, field.type, nullable, field.defaultValue]
      if (showComments) cells.push(field.comment)
      lines.push('| ' + cells.map(markdownCell).join(' | ') + ' |')
    }
    const extras = []
    const indexes = Array.isArray(input.indexes) ? input.indexes : null
    if (indexes) {
      const indexHeaders = input.indexHeaders || { name: 'index', kind: 'kind', columns: 'columns' }
      lines.push('', subPrefix + (input.indexHeading || 'Indexes'), '')
      if (indexes.length === 0) {
        lines.push(input.noIndexes || 'No indexes.')
      } else {
        lines.push(
          '| ' + [indexHeaders.name, indexHeaders.kind, indexHeaders.columns].map(markdownCell).join(' | ') + ' |',
          '| --- | --- | --- |',
        )
        for (const index of indexes) {
          lines.push('| ' + [
            index && index.name,
            indexKindLabel(index, input.indexKinds),
            index && Array.isArray(index.columns) ? index.columns.join(', ') : '',
          ].map(markdownCell).join(' | ') + ' |')
        }
      }
      const extra = indexStatements(qualified, indexes)
      if (extra) extras.push(extra)
    }
    const foreignKeys = Array.isArray(input.foreignKeys) ? input.foreignKeys : null
    if (foreignKeys) {
      const keyHeaders = input.foreignKeyHeaders || {
        name: 'foreign key',
        columns: 'columns',
        references: 'references',
        deleteRule: 'on delete',
        updateRule: 'on update',
      }
      lines.push('', subPrefix + (input.foreignKeyHeading || 'Foreign keys'), '')
      if (foreignKeys.length === 0) {
        lines.push(input.noForeignKeys || 'No foreign keys.')
      } else {
        const labels = [keyHeaders.name, keyHeaders.columns, keyHeaders.references, keyHeaders.deleteRule, keyHeaders.updateRule]
        lines.push('| ' + labels.map(markdownCell).join(' | ') + ' |', '| ' + labels.map(() => '---').join(' | ') + ' |')
        for (const key of foreignKeys) {
          lines.push('| ' + [
            key && key.name,
            key && Array.isArray(key.columns) ? key.columns.join(', ') : '',
            foreignKeyReference(key),
            key && key.deleteRule,
            key && key.updateRule,
          ].map(markdownCell).join(' | ') + ' |')
        }
      }
      const extra = foreignKeyStatements(qualified, foreignKeys)
      if (extra) extras.push(extra)
    }
    const commentSql = tableCommentStatement(qualified, tableComment, input.dbType)
    if (commentSql) extras.push(commentSql)
    if (extras.length) ddl += '\n\n' + extras.join('\n\n')
    if (ddl) lines.push('', subPrefix + (input.ddlHeading || 'DDL'), '', sqlFence(ddl))
    return { ddl, rowCount: fields.length, columnCount: showComments ? 5 : 4 }
  }

  function buildTableMarkdown(input) {
    const table = String(input.table || '').replace(/\r\n|\r|\n/g, ' ').trim()
    if (!table) {
      const error = new Error('NO_TABLE')
      error.code = 'NO_TABLE'
      throw error
    }
    const columns = Array.isArray(input.columns) ? input.columns : []
    if (columns.length === 0) {
      const error = new Error('NO_COLUMNS')
      error.code = 'NO_COLUMNS'
      throw error
    }
    const summary = input.summary || [input.database, input.schema, table].filter((item) => item != null && String(item) !== '').join(' · ')
    const title = tableTitle(input.title, table)
    const lines = []
    const section = writeTableSection(lines, { ...input, table, title, summary }, '# ', '## ')
    const page = finishMarkdown(title, lines)
    return {
      ...page,
      rowCount: section.rowCount,
      columnCount: section.columnCount || 4,
      ddl: section.ddl,
      indexes: Array.isArray(input.indexes) ? input.indexes : [],
      foreignKeys: Array.isArray(input.foreignKeys) ? input.foreignKeys : [],
    }
  }

  function buildTablesMarkdown(input) {
    const source = input && typeof input === 'object' ? input : {}
    const tables = (Array.isArray(source.tables) ? source.tables : []).filter((item) => item && String(item.table || '').trim())
    if (tables.length > 20) {
      const error = new Error('TOO_MANY')
      error.code = 'TOO_MANY'
      throw error
    }
    if (tables.length === 0) {
      const error = new Error('NO_TABLE')
      error.code = 'NO_TABLE'
      throw error
    }
    if (tables.length === 1) {
      return buildTableMarkdown({ ...source, ...tables[0], title: source.title || tables[0].table })
    }
    const title = tableTitle(source.title, tables[0].table)
    const lines = ['# ' + title, '']
    if (source.summary) lines.push(String(source.summary))
    if (source.note) lines.push('', String(source.note))
    let rowCount = 0
    let kept = 0
    let columnCount = 4
    for (const item of tables) {
      const section = writeTableSection(lines, {
        ...source,
        ...item,
        title: item.table,
        summary: '',
        note: item.comment || '',
      }, '## ', '### ')
      rowCount += section.rowCount
      if (section.rowCount) kept += 1
      if (section.columnCount > columnCount) columnCount = section.columnCount
    }
    if (!kept) {
      const error = new Error('NO_COLUMNS')
      error.code = 'NO_COLUMNS'
      throw error
    }
    const page = finishMarkdown(title, lines)
    return { ...page, rowCount, columnCount, tableCount: tables.length }
  }

  return {
    MAX_CELL_CHARS,
    MAX_MARKDOWN_BYTES,
    buildShareMarkdown,
    buildTableMarkdown,
    buildTablesMarkdown,
    columnCommentQuery,
    describeColumn,
    foreignKeyQuery,
    foreignKeyReference,
    indexCatalogQuery,
    indexKindLabel,
    markdownCell,
    parseColumnComments,
    parseForeignKeys,
    parseIndexRows,
    parseTableList,
    tableListQuery,
  }
})
