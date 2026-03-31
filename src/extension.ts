import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';

// SQLite database structure interfaces
interface SQLiteTable {
    name: string;
    columns: SQLiteColumn[];
}

interface SQLiteColumn {
    name: string;
    type: string;
    notnull: boolean;
    pk: boolean;
    values?: string[];
}

interface NameValuePair {
    tableName: string;
    columnName: string;
    colId: number;
    colType: string;
    values: string[];
}

interface DailSchemaLinking {
    num_date_match: Record<string, string>;
    cell_match: Record<string, string>;
}

interface DailSchemaDict {
    db_id: string;
    table_names: string[];
    table_names_original: string[];
    column_names: Array<[number, string]>;
    column_names_original: Array<[number, string]>;
    column_types: string[];
    primary_keys: number[];
    foreign_keys: Array<[number, number]>;
}

interface CvLink {
    num_date_match: Record<string, string>;
    cell_match: Record<string, string>;
}

interface DatabaseConnection {
    type: 'sqlite' | 'mysql';
    path?: string; // for sqlite
    host?: string; // for mysql
    port?: number; // for mysql
    username?: string; // for mysql
    password?: string; // for mysql
    database?: string;
    tables: SQLiteTable[];
}

interface MySQLConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database?: string;
}

interface UserFewShotRecord {
    index?: number;
    nlq: string;
    sql: string;
    db_id: string;
    created_at?: string;
    embedding?: number[];
    call_count?: number;
}

function mapToDailColumnType(rawType: string): string {
    const t = (rawType || '').toLowerCase();
    if (t.includes('int') || t.includes('real') || t.includes('num') || t.includes('float') || t.includes('double') || t.includes('decimal')) {
        return 'number';
    }
    if (t.includes('bool')) {
        return 'boolean';
    }
    if (t.includes('date') || t.includes('time')) {
        return 'time';
    }
    return 'text';
}

function tokenizeQuestion(q: string): string[] {
    const tokens = (q || '')
        .toLowerCase()
        .replace(/[`"'\\/\(\)\[\]{}<>,\.;:?\!\|]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    console.log('🧩 [tokenizeQuestion] frontend tokens', { question: q, tokens });
    return tokens;
}

function isNumericToken(tok: string): boolean {
    if (!tok) return false;
    return !isNaN(Number(tok));
}

function quoteIdentifier(id: string): string {
    return '"' + id.replace(/"/g, '""') + '"';
}


function executeSQL(dbPath: string, sql: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err: any) => {
            if (err) {
                reject(err);
                return;
            }
        });

        // 处理多条语句或注释等
        const cleanSql = sql
            .trim()
            .replace(/--.*$/gm, '') // 移除单行注释
            .replace(/\/\*[\s\S]*?\*\//g, '') // 移除多行注释
            .trim();

        if (!cleanSql) {
            db.close();
            resolve([]);
            return;
        }

        db.all(cleanSql, [], (err: any, rows: any[]) => {
            db.close();
            if (err) {
                console.warn('⚠️ SQL execution error:', err);
                reject(err);
            } else {
                // 如果是INSERT, UPDATE, DELETE等修改操作，返回空数组表示成功
                resolve(rows || []);
            }
        });
    });
}

function rowExists(dbPath: string, sql: string, params: any[] = []): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err: any) => {
            if (err) {
                reject(err);
                return;
            }
        });

        db.get(sql, params, (err: any, row: any) => {
            db.close();
            if (err) {
                reject(err);
            } else {
                resolve(!!row);
            }
        });
    });
}

async function hasPartialCellValueMatch(dbPath: string, tableName: string, columnName: string, token: string): Promise<boolean> {
    if (!token) return false;
    const qTable = quoteIdentifier(tableName);
    const qCol = quoteIdentifier(columnName);
    const sql = `SELECT 1 FROM ${qTable} WHERE ${qCol} LIKE ? OR ${qCol} LIKE ? OR ${qCol} LIKE ? OR ${qCol} LIKE ? LIMIT 1`;
    const params = [
        `${token} %`,
        `% ${token}`,
        `% ${token} %`,
        `${token}`
    ];
    try {
        return await rowExists(dbPath, sql, params);
    } catch (error) {
        return false;
    }
}

async function hasExactCellValueMatch(dbPath: string, tableName: string, columnName: string, phrase: string): Promise<boolean> {
    if (!phrase) return false;
    const qTable = quoteIdentifier(tableName);
    const qCol = quoteIdentifier(columnName);
    const sql = `SELECT 1 FROM ${qTable} WHERE ${qCol} LIKE ? OR ${qCol} LIKE ? OR ${qCol} LIKE ? OR ${qCol} LIKE ? LIMIT 1`;
    const params = [
        `${phrase}`,
        ` ${phrase}`,
        `${phrase} `,
        ` ${phrase} `
    ];
    try {
        return await rowExists(dbPath, sql, params);
    } catch (error) {
        return false;
    }
}

async function buildCvLinkFromLocalSQLite(question: string, dbPath: string, schema: DailSchemaDict, tables: SQLiteTable[], backendTokens?: string[]): Promise<CvLink> {
    const tokens = backendTokens && backendTokens.length > 0 ? backendTokens : tokenizeQuestion(question);
    console.log('🔧 [buildCvLinkFromLocalSQLite] using tokens', { question, backendTokens, tokens });

    const num_date_match: Record<string, string> = {};
    const cell_match: Record<string, string> = {};
    const tableMap: Record<string, SQLiteTable> = {};
    tables.forEach((t) => {
        tableMap[t.name] = t;
    });

    for (let colId = 1; colId < schema.column_names.length; colId++) {
        const [tableIdx, colName] = schema.column_names[colId];
        const colType = schema.column_types[colId] || 'text';
        const tableName = schema.table_names_original[tableIdx];

        const table = tableMap[tableName];
        if (!table) continue;

        const colEntry = table.columns.find(c => c.name.toLowerCase() === colName.toLowerCase() || c.name === schema.column_names_original[colId][1]);
        if (!colEntry) continue;

        const tokenMatched: number[] = [];

        for (let qId = 0; qId < tokens.length; qId++) {
            const token = tokens[qId];
            if (!token) continue;

            if (isNumericToken(token)) {
                if (colType === 'number' || colType === 'time') {
                    num_date_match[`${qId},${colId}`] = colType.toUpperCase();
                }
                continue;
            }

            const isPartial = await hasPartialCellValueMatch(dbPath, tableName, colEntry.name, token);
            if (isPartial) {
                tokenMatched.push(qId);
            }
        }

        // Compose contiguous token spans to detect exact phrase and partial phrase
        let start = 0;
        while (start < tokenMatched.length) {
            let end = start;
            while (end + 1 < tokenMatched.length && tokenMatched[end + 1] === tokenMatched[end] + 1) {
                end++;
            }

            const phrase = tokens.slice(tokenMatched[start], tokenMatched[end] + 1).join(' ');
            const exact = await hasExactCellValueMatch(dbPath, tableName, colEntry.name, phrase);
            const matchType = exact ? 'EXACTMATCH' : 'PARTIALMATCH';

            for (let idx = tokenMatched[start]; idx <= tokenMatched[end]; idx++) {
                cell_match[`${idx},${colId}`] = matchType;
            }

            start = end + 1;
        }
    }

    const cvLink: CvLink = {
        num_date_match,
        cell_match
    };

    console.log('🔍 [cv_link] buildCvLinkFromLocalSQLite result', {
        num_date_match_count: Object.keys(num_date_match).length,
        cell_match_count: Object.keys(cell_match).length,
        cvLink: JSON.stringify(cvLink, null, 2)
    });

    return cvLink;
}

function buildDailSchemaFromTables(databaseId: string, tables: SQLiteTable[]): DailSchemaDict {
    const tableNames = tables.map(t => t.name);
    const columnNames: Array<[number, string]> = [[-1, '*']];
    const columnNamesOriginal: Array<[number, string]> = [[-1, '*']];
    const columnTypes: string[] = ['text'];
    const primaryKeys: number[] = [];
    const foreignKeys: Array<[number, number]> = [];

    let columnIndex = 1;
    tables.forEach((table, tableIndex) => {
        table.columns.forEach(col => {
            columnNames.push([tableIndex, col.name.toLowerCase()]);
            columnNamesOriginal.push([tableIndex, col.name]);
            columnTypes.push(mapToDailColumnType(col.type));
            if (col.pk) {
                primaryKeys.push(columnIndex);
            }
            columnIndex += 1;
        });
    });

    return {
        db_id: databaseId,
        table_names: tableNames,
        table_names_original: tableNames,
        column_names: columnNames,
        column_names_original: columnNamesOriginal,
        column_types: columnTypes,
        primary_keys: primaryKeys,
        foreign_keys: foreignKeys,
    };
}

// This method is called when the extension is activated
// The extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    console.log('NL2SQL extension is now active!');

    // Register command: Convert Natural Language to SQL (display in new document)
    let convertCommand = vscode.commands.registerCommand('nl2sql.convertQuery', async () => {
        const editor = vscode.window.activeTextEditor;
        
        if (editor) {
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);
            
            if (selectedText) {
                // Call NL2SQL conversion function, default to car_1 database
                const sqlQuery = await convertNaturalLanguageToSQL(selectedText, 'car_1');
                
                // Display result in new document
                const doc = await vscode.workspace.openTextDocument({
                    content: sqlQuery,
                    language: 'sql'
                });
                await vscode.window.showTextDocument(doc);
            } else {
                vscode.window.showErrorMessage('Please select natural language text to convert');
            }
        }
    });

    // Register command: Replace directly with SQL
    let replaceCommand = vscode.commands.registerCommand('nl2sql.replaceWithSQL', async () => {
        const editor = vscode.window.activeTextEditor;
        
        if (editor) {
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);
            
            if (selectedText) {
                // Call NL2SQL conversion function, default to car_1 database
                const sqlQuery = await convertNaturalLanguageToSQL(selectedText, 'car_1');
                
                // Replace selected text directly
                await editor.edit(editBuilder => {
                    editBuilder.replace(selection, sqlQuery);
                });
                
                vscode.window.showInformationMessage('Natural language converted to SQL and replaced');
            } else {
                vscode.window.showErrorMessage('Please select natural language text to convert');
            }
        }
    });

    // Register command: Open NL2SQL panel
    let panelCommand = vscode.commands.registerCommand('nl2sql.openPanel', () => {
        NL2SQLPanel.createOrShow(context.extensionUri, context);
    });

    // Register command: Test DAIL-SQL API connection
    let testApiCommand = vscode.commands.registerCommand('nl2sql.testDailSqlApi', async () => {
        try {
            await testDailSqlApiConnection();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`DAIL-SQL API test failed: ${message}`);
        }
    });

    // Register command: Upload SQLite database to DAIL-SQL
    let uploadDbCommand = vscode.commands.registerCommand('nl2sql.uploadDatabase', async () => {
        try {
            await uploadSQLiteDatabase();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Database upload failed: ${message}`);
        }
    });

    // Register command: Configure MySQL connection
    let mysqlConfigCommand = vscode.commands.registerCommand('nl2sql.configureMysql', async () => {
        const host = await vscode.window.showInputBox({
            prompt: 'Enter MySQL host',
            value: 'localhost'
        });
        if (!host) return;

        const port = await vscode.window.showInputBox({
            prompt: 'Enter MySQL port',
            value: '3306'
        });
        if (!port) return;

        const username = await vscode.window.showInputBox({
            prompt: 'Enter MySQL username',
            value: 'root'
        });
        if (!username) return;

        const password = await vscode.window.showInputBox({
            prompt: 'Enter MySQL password',
            password: true
        });
        if (password === undefined) return;

        // Test connection
        const config: MySQLConfig = {
            host,
            port: parseInt(port),
            user: username,
            password
        };

        console.log('Testing MySQL connection with config:', { host, port, user: username });
        const result = await testMySQLConnection(config);
        if (!result.success) {
            vscode.window.showErrorMessage('Failed to connect to MySQL: ' + (result.error || 'Unknown error'));
            return;
        }

        // Store configuration (securely)
        await context.secrets.store('mysql-host', host);
        await context.secrets.store('mysql-port', port);
        await context.secrets.store('mysql-username', username);
        await context.secrets.store('mysql-password', password);

        vscode.window.showInformationMessage('MySQL connection configured successfully!');
        
        // Auto refresh database list if panel is open
        if (NL2SQLPanel.currentPanel) {
            console.log('Auto-refreshing database list after MySQL configuration');
            try {
                const databases = await getMySQLDatabases(config);
                NL2SQLPanel.currentPanel._panel.webview.postMessage({ 
                    command: 'databases', 
                    databases: databases.map(name => ({ name, path: name })) 
                });
            } catch (error) {
                console.error('Error auto-refreshing databases:', error);
            }
        }
    });

    context.subscriptions.push(convertCommand);
    context.subscriptions.push(replaceCommand);
    context.subscriptions.push(panelCommand);
    context.subscriptions.push(mysqlConfigCommand);
    context.subscriptions.push(testApiCommand);
    context.subscriptions.push(uploadDbCommand);
}

// This method is called when your extension is deactivated
export function deactivate() {}
// SQLite helper functions
async function findSQLiteFiles(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return [];
    }

    const sqliteFiles: string[] = [];
    for (const folder of workspaceFolders) {
        const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, '**/*.{db,sqlite,sqlite3}'),
            null
            // No file limit - will find all SQLite files
        );
        sqliteFiles.push(...files.map(file => file.fsPath));
    }
    return sqliteFiles;
}

async function readSQLiteSchema(dbPath: string): Promise<SQLiteTable[]> {
    return new Promise((resolve, reject) => {
        try {
            const sqlite3 = require('sqlite3').verbose();
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err: any) => {
                if (err) {
                    reject(err);
                    return;
                }
            });

            // Get all table names
            db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], (err: any, tables: any[]) => {
                if (err) {
                    db.close();
                    reject(err);
                    return;
                }

                const tablePromises = tables.map((table: any) => {
                    return new Promise<SQLiteTable>((resolveTable, rejectTable) => {
                        // Get columns for each table
                        db.all(`PRAGMA table_info(${table.name})`, [], (err: any, columns: any[]) => {
                            if (err) {
                                rejectTable(err);
                                return;
                            }

                            const sqliteColumns: SQLiteColumn[] = columns.map(col => ({
                                name: col.name,
                                type: col.type,
                                notnull: col.notnull === 1,
                                pk: col.pk === 1,
                                values: []
                            }));

                            // Fetch sample values for each column to support cv_link generation
                            const valuePromises = sqliteColumns.map((col) => {
                                return new Promise<void>((resolveCol, rejectCol) => {
                                    const safeColName = `"${col.name.replace(/"/g, '')}"`;
                                    db.all(
                                        `SELECT DISTINCT ${safeColName} AS val FROM \"${table.name.replace(/\"/g, '')}\" WHERE ${safeColName} IS NOT NULL LIMIT 200`,
                                        [],
                                        (valErr: any, valRows: any[]) => {
                                            if (valErr) {
                                                col.values = [];
                                                return resolveCol();
                                            }

                                            col.values = valRows
                                                .map((r: any) => (r.val === null || r.val === undefined ? '' : String(r.val).trim()))
                                                .filter((v: string) => v.length > 0)
                                                .slice(0, 200);
                                            resolveCol();
                                        }
                                    );
                                });
                            });

                            Promise.all(valuePromises)
                                .then(() => {
                                    resolveTable({
                                        name: table.name,
                                        columns: sqliteColumns
                                    });
                                })
                                .catch((e) => {
                                    console.error('Error fetching sample values for table', table.name, e);
                                    resolveTable({
                                        name: table.name,
                                        columns: sqliteColumns
                                    });
                                });
                        });
                    });
                });

                Promise.all(tablePromises)
                    .then(result => {
                        db.close();
                        resolve(result);
                    })
                    .catch(err => {
                        db.close();
                        reject(err);
                    });
            });

        } catch (error) {
            reject(error);
        }
    });
}

// MySQL helper functions
async function getMySQLDatabases(config: MySQLConfig): Promise<string[]> {
    return new Promise((resolve, reject) => {
        try {
            console.log('Getting MySQL databases for:', config.host);
            const mysql = require('mysql2');
            const connection = mysql.createConnection({
                host: config.host,
                port: config.port,
                user: config.user,
                password: config.password,
                connectTimeout: 5000
            });

            connection.connect((err: any) => {
                if (err) {
                    console.error('Connection error in getMySQLDatabases:', err);
                    reject(new Error('Connection failed: ' + (err.message || err.code)));
                    return;
                }
                
                console.log('Connected, fetching databases...');
            });

            connection.query('SHOW DATABASES', (err: any, results: any[]) => {
                connection.end();
                if (err) {
                    console.error('Query error in getMySQLDatabases:', err);
                    reject(new Error('Query failed: ' + (err.message || err.code)));
                    return;
                }
                
                console.log('Raw database results:', results);
                const databases = results
                    .map((row: any) => row.Database)
                    .filter((db: string) => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(db));
                
                console.log('Filtered databases:', databases);
                resolve(databases);
            });

        } catch (error) {
            console.error('Exception in getMySQLDatabases:', error);
            reject(error);
        }
    });
}

async function readMySQLSchema(config: MySQLConfig): Promise<SQLiteTable[]> {
    return new Promise((resolve, reject) => {
        try {
            const mysql = require('mysql2');
            const connection = mysql.createConnection({
                host: config.host,
                port: config.port,
                user: config.user,
                password: config.password,
                database: config.database
            });

            connection.connect((err: any) => {
                if (err) {
                    reject(err);
                    return;
                }
            });

            // Get all table names
            connection.query('SHOW TABLES', (err: any, tables: any[]) => {
                if (err) {
                    connection.end();
                    reject(err);
                    return;
                }

                const tableKey = `Tables_in_${config.database}`;
                const tablePromises = tables.map((tableRow: any) => {
                    const tableName = tableRow[tableKey];
                    
                    return new Promise<SQLiteTable>((resolveTable, rejectTable) => {
                        // Get columns for each table
                        connection.query(`DESCRIBE ${tableName}`, (err: any, columns: any[]) => {
                            if (err) {
                                rejectTable(err);
                                return;
                            }

                            const mysqlColumns: SQLiteColumn[] = columns.map(col => ({
                                name: col.Field,
                                type: col.Type,
                                notnull: col.Null === 'NO',
                                pk: col.Key === 'PRI'
                            }));

                            resolveTable({
                                name: tableName,
                                columns: mysqlColumns
                            });
                        });
                    });
                });

                Promise.all(tablePromises)
                    .then(result => {
                        connection.end();
                        resolve(result);
                    })
                    .catch(err => {
                        connection.end();
                        reject(err);
                    });
            });

        } catch (error) {
            reject(error);
        }
    });
}

async function testMySQLConnection(config: MySQLConfig): Promise<{success: boolean, error?: string}> {
    return new Promise((resolve) => {
        try {
            console.log('Testing MySQL connection to:', config.host, ':', config.port);
            const mysql = require('mysql2');
            const connection = mysql.createConnection({
                host: config.host,
                port: config.port,
                user: config.user,
                password: config.password,
                connectTimeout: 5000, // 5 second timeout
                acquireTimeout: 5000,
                timeout: 5000
            });

            connection.connect((err: any) => {
                if (err) {
                    console.error('MySQL connection error:', err.code, err.message);
                    connection.destroy();
                    let errorMessage = 'Connection failed: ';
                    
                    switch(err.code) {
                        case 'ECONNREFUSED':
                            errorMessage += 'Connection refused. Make sure MySQL server is running on ' + config.host + ':' + config.port;
                            break;
                        case 'ER_ACCESS_DENIED_ERROR':
                            errorMessage += 'Access denied. Check username and password.';
                            break;
                        case 'ENOTFOUND':
                            errorMessage += 'Host not found. Check hostname: ' + config.host;
                            break;
                        case 'ETIMEDOUT':
                            errorMessage += 'Connection timeout. Check if MySQL server is accessible.';
                            break;
                        default:
                            errorMessage += err.message || err.code;
                    }
                    
                    resolve({success: false, error: errorMessage});
                    return;
                }
                
                console.log('MySQL connection successful');
                connection.end();
                resolve({success: true});
            });

        } catch (error) {
            console.error('MySQL test connection exception:', error);
            resolve({success: false, error: 'Exception: ' + (error as Error).message});
        }
    });
}

// Get stored MySQL configuration
async function getMySQLConfig(context: vscode.ExtensionContext): Promise<MySQLConfig | null> {
    try {
        const host = await context.secrets.get('mysql-host');
        const port = await context.secrets.get('mysql-port');
        const user = await context.secrets.get('mysql-username');
        const password = await context.secrets.get('mysql-password');

        if (!host || !port || !user || password === undefined) {
            return null;
        }

        return {
            host,
            port: parseInt(port),
            user,
            password
        };
    } catch (error) {
        return null;
    }
}

// DAIL-SQL API Configuration
interface DailSQLConfig {
    apiUrl: string;
    timeout: number;
}

// Get DAIL-SQL API configuration from VS Code settings
async function getDailSQLConfig(context: vscode.ExtensionContext): Promise<DailSQLConfig> {
    const config = vscode.workspace.getConfiguration('nl2sql');
    return {
        apiUrl: config.get<string>('dailsql.apiUrl') || 'http://localhost:8000',
        timeout: config.get<number>('dailsql.timeout') || 300000
    };
}

// DAIL-SQL API client function
async function convertNaturalLanguageToSQL(naturalLanguage: string, database: string = 'mysql', schema?: SQLiteTable[]): Promise<string> {
    try {
        // Get DAIL-SQL configuration from VS Code settings
        const config = vscode.workspace.getConfiguration('nl2sql');
        const apiUrl = config.get<string>('dailsql.apiUrl') || 'http://localhost:8000';
        const timeout = config.get<number>('dailsql.timeout') || 300000;
        
        // Check if DAIL-SQL service is available
        try {
            await axios.get(`${apiUrl}/api/v1/health`, { timeout: 5000 });
        } catch (error) {
            console.warn('DAIL-SQL service not available, falling back to template matching');
            return await fallbackConvertNaturalLanguageToSQL(naturalLanguage, database, schema);
        }
        
        // 测试数据库列表获取
        try {
            const dbListResponse = await axios.get(`${apiUrl}/api/v1/databases`, { timeout: 5000 });
            console.log('🔍 Available databases from DAIL-SQL server:', dbListResponse.data);
            
            // 检查请求的数据库是否存在
            const availableDbs = dbListResponse.data || [];
            const requestedDb = database || 'car_1';
            const dbExists = availableDbs.some((db: any) => db.database_id === requestedDb);
            
            if (!dbExists) {
                const availableIds = availableDbs.map((db: any) => db.database_id).join(', ');
                console.error(`❌ Database '${requestedDb}' not found in server configuration`);
                console.error('📋 Available databases on server:', availableDbs.map((db: any) => ({ id: db.database_id, tables: db.tables?.length || 0, description: db.description })));
                
                vscode.window.showWarningMessage(
                    `Database '${requestedDb}' not available on DAIL-SQL server.\n` +
                    `Available databases: ${availableIds || 'None'}\n` +
                    `请检查DAIL-SQL服务器的数据库配置。\n` +
                    `使用模板匹配作为后备方案。`,
                    { modal: false }  // Changed to non-modal to avoid blocking
                );
                return await fallbackConvertNaturalLanguageToSQL(naturalLanguage, database, schema);
            } else {
                const dbInfo = availableDbs.find((db: any) => db.database_id === requestedDb);
                console.log(`✅ Database '${requestedDb}' confirmed available with ${dbInfo?.tables?.length || 0} tables`);
            }
        } catch (error) {
            console.warn('⚠️ Could not fetch database list, proceeding with request:', error);
        }
        
        // Prepare request data with configurable parameters
        const requestData: any = {
            question: naturalLanguage,
            database_id: database || 'car_1'
        };
        
        // 添加可选参数（从VS Code设置中获取，如果没有则不添加）
        const model = config.get<string>('dailsql.model');
        const temperature = config.get<number>('dailsql.temperature');
        const maxRetries = config.get<number>('dailsql.maxRetries');
        const kShot = config.get<number>('dailsql.kShot');
        const useSelfConsistency = config.get<boolean>('dailsql.useSelfConsistency');
        const nCandidates = config.get<number>('dailsql.nCandidates');
        
        if (model) requestData.model = model;
        if (temperature !== undefined) requestData.temperature = temperature;
        if (maxRetries !== undefined) requestData.max_retries = maxRetries;
        if (kShot !== undefined) requestData.k_shot = kShot;
        if (useSelfConsistency !== undefined) requestData.use_self_consistency = useSelfConsistency;
        if (nCandidates !== undefined) requestData.n_candidates = nCandidates;
        
        // Debug: Log the request being sent
        console.log('DAIL-SQL API Request Details:');
        console.log('  URL:', `${apiUrl}/api/v1/text-to-sql`);
        console.log('  Question:', naturalLanguage);
        console.log('  Database parameter (input):', database);
        console.log('  Database_id (final):', requestData.database_id);
        console.log('  Request headers:', {
            'Content-Type': 'application/json',
            'User-Agent': 'VSCode-NL2SQL-Extension'
        });
        console.log('  Full request data:', JSON.stringify(requestData, null, 2));
        console.log('  Request data size:', JSON.stringify(requestData).length, 'bytes');
        
        // 验证请求数据
        if (!requestData.question || requestData.question.trim() === '') {
            throw new Error('Question cannot be empty');
        }
        if (!requestData.database_id || requestData.database_id.trim() === '') {
            throw new Error('Database ID cannot be empty');
        }
        
        // Call DAIL-SQL API with detailed configuration
        const axiosConfig = {
            timeout: timeout,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'VSCode-NL2SQL-Extension/0.0.1'
            },
            // 确保请求体被正确序列化
            transformRequest: [(data: any) => {
                const serialized = JSON.stringify(data);
                console.log('Final serialized request:', serialized);
                return serialized;
            }],
            // 响应拦截器
            transformResponse: [(data: any) => {
                console.log('Raw response received:', typeof data, data);
                try {
                    return typeof data === 'string' ? JSON.parse(data) : data;
                } catch (e) {
                    console.error('Failed to parse response as JSON:', e);
                    return data;
                }
            }]
        };
        
        console.log('Making request with config:', axiosConfig);
        const response = await axios.post(`${apiUrl}/api/v1/text-to-sql`, requestData, axiosConfig);
        
        // Debug: Log the actual response
        console.log('DAIL-SQL API Response Details:');
        console.log('  Status:', response.status);
        console.log('  Success:', response.data?.success);
        console.log('  Processing steps count:', response.data?.processing_steps?.length || 0);
        console.log('  Processing steps:', response.data?.processing_steps || []);
        console.log('  SQL result:', response.data?.best_sql || 'None');
        console.log('  Error:', response.data?.error || 'None');
        console.log('  Attempts:', response.data?.attempts || 0);
        console.log('  Execution time:', response.data?.execution_time || 0);
        console.log('  Full response:', JSON.stringify(response.data, null, 2));
        
        // 详细分析失败原因
        if (!response.data?.success) {
            console.error('DAIL-SQL API 失败分析:');
            console.error('  - 数据库验证:', response.data?.processing_steps?.includes('✅ 验证数据库') ? '成功' : '失败');
            console.error('  - 处理步骤数量:', response.data?.processing_steps?.length || 0);
            console.error('  - 错误信息:', response.data?.error || '无错误信息');
            console.error('  - 尝试次数:', response.data?.attempts || 0);
            
            if (response.data?.processing_steps?.length === 1) {
                console.error('  -> 可能原因: LLM配置问题（API密钥、模型配置等）');
            }
        }
        
        if (response.data && response.data.success && response.data.best_sql) {
            // 直接返回干净的SQL，不添加任何注释
            return response.data.best_sql;
        } else {
            console.error('DAIL-SQL API Error Response:', response.data);
            throw new Error('Invalid response from DAIL-SQL API: ' + (response.data?.error || JSON.stringify(response.data)));
        }
        
    } catch (error) {
        console.error('Error calling DAIL-SQL API:', error);
        
        // Fallback to template matching if API fails
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showWarningMessage(
            `DAIL-SQL API failed (${errorMessage}), using template matching instead`
        );
        
        return await fallbackConvertNaturalLanguageToSQL(naturalLanguage, database, schema);
    }
}

// Fallback template-based conversion function (original logic)
async function fallbackConvertNaturalLanguageToSQL(naturalLanguage: string, database: string = 'mysql', schema?: SQLiteTable[]): Promise<string> {
    const input = naturalLanguage.toLowerCase();
    let sql = '';
    
    // Generate different SQL syntax based on database type
    const dbSyntax = {
        mysql: {
            limit: 'LIMIT',
            quote: '`',
            autoIncrement: 'AUTO_INCREMENT',
            now: 'NOW()'
        },
        postgresql: {
            limit: 'LIMIT',
            quote: '"',
            autoIncrement: 'SERIAL',
            now: 'CURRENT_TIMESTAMP'
        },
        sqlite: {
            limit: 'LIMIT',
            quote: '"',
            autoIncrement: 'AUTOINCREMENT',
            now: "datetime('now')"
        },
        sqlserver: {
            limit: 'TOP',
            quote: '[',
            autoIncrement: 'IDENTITY',
            now: 'GETDATE()'
        },
        oracle: {
            limit: 'ROWNUM <=',
            quote: '"',
            autoIncrement: 'AUTO_INCREMENT',
            now: 'SYSDATE'
        },
        mongodb: {
            limit: 'limit()',
            quote: '',
            autoIncrement: '_id',
            now: 'new Date()'
        }
    };

    const syntax = dbSyntax[database as keyof typeof dbSyntax] || dbSyntax.mysql;
    
    // Smart table and column matching using schema
    let targetTable = '';
    let availableColumns: string[] = [];
    
    if (schema && schema.length > 0) {
        // Try to find matching table based on natural language
        const input = naturalLanguage.toLowerCase();
        
        for (const table of schema) {
            const tableName = table.name.toLowerCase();
            if (input.includes(tableName) || 
                input.includes(tableName.replace(/s$/, '')) || // singular form
                input.includes(tableName + 's')) { // plural form
                targetTable = table.name;
                availableColumns = table.columns.map(col => col.name);
                break;
            }
        }
        
        // If no specific table found, use the first table as default
        if (!targetTable && schema.length > 0) {
            targetTable = schema[0].name;
            availableColumns = schema[0].columns.map(col => col.name);
        }
    }
    
    // Query related keywords
    if (input.includes('query') || input.includes('get') || input.includes('find') || input.includes('select') || 
        input.includes('fetch') || input.includes('retrieve')) {
        if (input.includes('user') || input.includes('users') || input.includes('customer') || input.includes('customers')) {
            if (input.includes('name') && input.includes('email')) {
                sql = database === 'mongodb' 
                    ? `// ${naturalLanguage}\ndb.users.find({}, {name: 1, email: 1});`
                    : `-- ${naturalLanguage}\nSELECT ${syntax.quote}name${syntax.quote === '[' ? ']' : syntax.quote}, ${syntax.quote}email${syntax.quote === '[' ? ']' : syntax.quote}\nFROM ${syntax.quote}users${syntax.quote === '[' ? ']' : syntax.quote};`;
            } else {
                sql = database === 'mongodb' 
                    ? `// ${naturalLanguage}\ndb.users.find({});`
                    : `-- ${naturalLanguage}\nSELECT *\nFROM ${syntax.quote}users${syntax.quote === '[' ? ']' : syntax.quote};`;
            }
        } else if (input.includes('order') || input.includes('orders') || input.includes('purchase')) {
            if (input.includes('recent') || input.includes('30 days') || input.includes('week') || input.includes('last')) {
                sql = database === 'mongodb' 
                    ? `// ${naturalLanguage}\ndb.orders.find({created_at: {$gte: new Date(Date.now() - 30*24*60*60*1000)}});`
                    : `-- ${naturalLanguage}\nSELECT *\nFROM ${syntax.quote}orders${syntax.quote === '[' ? ']' : syntax.quote}\nWHERE ${syntax.quote}created_at${syntax.quote === '[' ? ']' : syntax.quote} >= DATE_SUB(${syntax.now}, INTERVAL 30 DAY);`;
            } else {
                sql = database === 'mongodb' 
                    ? `// ${naturalLanguage}\ndb.orders.find({});`
                    : `-- ${naturalLanguage}\nSELECT *\nFROM ${syntax.quote}orders${syntax.quote === '[' ? ']' : syntax.quote};`;
            }
        } else if (input.includes('product') || input.includes('products') || input.includes('item')) {
            if (input.includes('price') && (input.includes('greater') || input.includes('more than') || input.includes('above'))) {
                sql = database === 'mongodb' 
                    ? `// ${naturalLanguage}\ndb.products.find({price: {$gt: 100}});`
                    : `-- ${naturalLanguage}\nSELECT *\nFROM ${syntax.quote}products${syntax.quote === '[' ? ']' : syntax.quote}\nWHERE ${syntax.quote}price${syntax.quote === '[' ? ']' : syntax.quote} > 100;`;
            } else {
                sql = database === 'mongodb' 
                    ? `// ${naturalLanguage}\ndb.products.find({});`
                    : `-- ${naturalLanguage}\nSELECT *\nFROM ${syntax.quote}products${syntax.quote === '[' ? ']' : syntax.quote};`;
            }
        }
    }
    
    // Statistics related keywords
    if (input.includes('count') || input.includes('statistics') || input.includes('total') || input.includes('sum')) {
        if (input.includes('category') || input.includes('department') || input.includes('group') || input.includes('type')) {
            sql = database === 'mongodb' 
                ? `// ${naturalLanguage}\ndb.products.aggregate([{$group: {_id: "$category", count: {$sum: 1}}}]);`
                : `-- ${naturalLanguage}\nSELECT ${syntax.quote}category${syntax.quote === '[' ? ']' : syntax.quote}, COUNT(*) as count\nFROM ${syntax.quote}products${syntax.quote === '[' ? ']' : syntax.quote}\nGROUP BY ${syntax.quote}category${syntax.quote === '[' ? ']' : syntax.quote};`;
        }
    }
    
    // Insert related keywords
    if (input.includes('insert') || input.includes('add') || input.includes('create') || input.includes('new')) {
        if (input.includes('用户') || input.includes('user')) {
            sql = database === 'mongodb' 
                ? `// ${naturalLanguage}\ndb.users.insertOne({name: "New User", email: "user@example.com", created_at: new Date()});`
                : `-- ${naturalLanguage}\nINSERT INTO ${syntax.quote}users${syntax.quote === '[' ? ']' : syntax.quote} (${syntax.quote}name${syntax.quote === '[' ? ']' : syntax.quote}, ${syntax.quote}email${syntax.quote === '[' ? ']' : syntax.quote}, ${syntax.quote}created_at${syntax.quote === '[' ? ']' : syntax.quote})\nVALUES ('New User', 'user@example.com', ${syntax.now});`;
        } else {
            sql = database === 'mongodb' 
                ? `// ${naturalLanguage}\ndb.collection.insertOne({field1: "value1", field2: "value2"});`
                : `-- ${naturalLanguage}\nINSERT INTO ${syntax.quote}table_name${syntax.quote === '[' ? ']' : syntax.quote} (${syntax.quote}column1${syntax.quote === '[' ? ']' : syntax.quote}, ${syntax.quote}column2${syntax.quote === '[' ? ']' : syntax.quote})\nVALUES ('value1', 'value2');`;
        }
    }
    
    // Update related keywords
    if (input.includes('update') || input.includes('modify') || input.includes('change') || input.includes('edit')) {
        if (input.includes('email') || input.includes('mail') || input.includes('address')) {
            sql = database === 'mongodb' 
                ? `// ${naturalLanguage}\ndb.users.updateOne({_id: ObjectId("user_id")}, {$set: {email: "new@example.com"}});`
                : `-- ${naturalLanguage}\nUPDATE ${syntax.quote}users${syntax.quote === '[' ? ']' : syntax.quote}\nSET ${syntax.quote}email${syntax.quote === '[' ? ']' : syntax.quote} = 'new@example.com'\nWHERE ${syntax.quote}id${syntax.quote === '[' ? ']' : syntax.quote} = 1;`;
        } else {
            sql = database === 'mongodb' 
                ? `// ${naturalLanguage}\ndb.collection.updateOne({condition}, {$set: {field: "new_value"}});`
                : `-- ${naturalLanguage}\nUPDATE ${syntax.quote}table_name${syntax.quote === '[' ? ']' : syntax.quote}\nSET ${syntax.quote}column1${syntax.quote === '[' ? ']' : syntax.quote} = 'new_value'\nWHERE condition;`;
        }
    }
    
    // Delete related keywords
    if (input.includes('delete') || input.includes('remove') || input.includes('drop')) {
        if (input.includes('expired') || input.includes('cancelled') || input.includes('inactive') || input.includes('deleted')) {
            sql = database === 'mongodb' 
                ? `// ${naturalLanguage}\ndb.orders.deleteMany({status: "cancelled"});`
                : `-- ${naturalLanguage}\nDELETE FROM ${syntax.quote}orders${syntax.quote === '[' ? ']' : syntax.quote}\nWHERE ${syntax.quote}status${syntax.quote === '[' ? ']' : syntax.quote} = 'cancelled';`;
        } else {
            sql = database === 'mongodb' 
                ? `// ${naturalLanguage}\ndb.collection.deleteOne({condition});`
                : `-- ${naturalLanguage}\nDELETE FROM ${syntax.quote}table_name${syntax.quote === '[' ? ']' : syntax.quote}\nWHERE condition;`;
        }
    }
    
    // If no patterns matched
    if (!sql) {
        sql = database === 'mongodb' 
            ? `// ${naturalLanguage}\n// Sorry, unable to recognize this query. Please provide more specific description.\ndb.collection.find({});`
            : `-- ${naturalLanguage}\n-- Sorry, unable to recognize this query. Please provide more specific description.\nSELECT * FROM ${syntax.quote}table_name${syntax.quote === '[' ? ']' : syntax.quote};`;
    }
    
    return sql;
}

// SQL to Natural Language conversion function
async function convertSQLToNaturalLanguage(sql: string, database: string = 'mysql'): Promise<string> {
    const sqlLower = sql.toLowerCase().trim();
    
    // Remove comments and extra whitespace
    const cleanSQL = sqlLower.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    
    // SELECT query parsing
    if (cleanSQL.includes('select')) {
        let description = 'Query';
        
        // Parse table name
        const fromMatch = cleanSQL.match(/from\s+[`"']?(\w+)[`"']?/);
        const tableName = fromMatch ? fromMatch[1] : 'table';
        
        // Parse fields
        const selectMatch = cleanSQL.match(/select\s+(.*?)\s+from/);
        const fields = selectMatch ? selectMatch[1].trim() : '*';
        
        if (fields === '*') {
            description += ` all information from ${tableName} table`;
        } else if (fields.includes('count')) {
            description += ` count of records from ${tableName} table`;
        } else {
            const fieldList = fields.split(',').map(f => f.trim().replace(/[`"'\[\]]/g, ''));
            description += ` ${fieldList.join(', ')} fields from ${tableName} table`;
        }
        
        // Parse WHERE conditions
        if (cleanSQL.includes('where')) {
            const whereMatch = cleanSQL.match(/where\s+(.*?)(?:\s+group|\s+order|\s+limit|$)/);
            if (whereMatch) {
                const condition = whereMatch[1].trim();
                
                if (condition.includes('>') && condition.includes('price')) {
                    const priceMatch = condition.match(/price\s*>\s*(\d+)/);
                    if (priceMatch) {
                        description += `, where price is greater than ${priceMatch[1]}`;
                    }
                } else if (condition.includes('age')) {
                    description += ', filtered by age condition';
                } else if (condition.includes('status')) {
                    if (condition.includes('cancelled') || condition.includes('canceled')) {
                        description += ', where status is cancelled';
                    } else {
                        description += ', filtered by status condition';
                    }
                } else if (condition.includes('created_at') || condition.includes('date')) {
                    description += ', filtered by date condition';
                } else {
                    description += ', with specific conditions';
                }
            }
        }
        
        // Parse GROUP BY
        if (cleanSQL.includes('group by')) {
            const groupMatch = cleanSQL.match(/group\s+by\s+[`"']?(\w+)[`"']?/);
            if (groupMatch) {
                description += `, grouped by ${groupMatch[1]}`;
            }
        }
        
        // Parse ORDER BY
        if (cleanSQL.includes('order by')) {
            if (cleanSQL.includes('desc')) {
                description += ', ordered in descending order';
            } else {
                description += ', ordered in ascending order';
            }
        }
        
        // Parse LIMIT
        if (cleanSQL.includes('limit')) {
            const limitMatch = cleanSQL.match(/limit\s+(\d+)/);
            if (limitMatch) {
                description += `, limited to ${limitMatch[1]} records`;
            }
        }
        
        return description;
    }
    
    // INSERT parsing
    if (cleanSQL.includes('insert')) {
        const tableMatch = cleanSQL.match(/insert\s+into\s+[`"']?(\w+)[`"']?/);
        const tableName = tableMatch ? tableMatch[1] : 'table';
        
        if (tableName === 'users' || tableName.includes('user')) {
            return `Insert new user record into users table`;
        } else if (tableName === 'orders' || tableName.includes('order')) {
            return `Add new order information to orders table`;
        } else if (tableName === 'products' || tableName.includes('product')) {
            return `Add new product information to products table`;
        } else {
            return `Insert new data record into ${tableName} table`;
        }
    }
    
    // UPDATE parsing
    if (cleanSQL.includes('update')) {
        const tableMatch = cleanSQL.match(/update\s+[`"']?(\w+)[`"']?/);
        const tableName = tableMatch ? tableMatch[1] : 'table';
        
        let description = `Update data in ${tableName} table`;
        
        // Check SET fields
        if (cleanSQL.includes('email')) {
            description += ', modify email address';
        } else if (cleanSQL.includes('password')) {
            description += ', modify password';
        } else if (cleanSQL.includes('status')) {
            description += ', modify status';
        } else if (cleanSQL.includes('name')) {
            description += ', modify name information';
        }
        
        // Check WHERE conditions
        if (cleanSQL.includes('where')) {
            description += ', for records that meet the condition';
        }
        
        return description;
    }
    
    // DELETE parsing
    if (cleanSQL.includes('delete')) {
        const fromMatch = cleanSQL.match(/from\s+[`"']?(\w+)[`"']?/);
        const tableName = fromMatch ? fromMatch[1] : 'table';
        
        let description = `Delete data from ${tableName} table`;
        
        if (cleanSQL.includes('where')) {
            if (cleanSQL.includes('status') && (cleanSQL.includes('cancelled') || cleanSQL.includes('canceled'))) {
                description += ', delete cancelled records';
            } else if (cleanSQL.includes('expired')) {
                description += ', delete expired records';
            } else {
                description += ', delete records that meet the condition';
            }
        } else {
            description += ', clear all records';
        }
        
        return description;
    }
    
    // CREATE TABLE parsing
    if (cleanSQL.includes('create table')) {
        const tableMatch = cleanSQL.match(/create\s+table\s+[`"']?(\w+)[`"']?/);
        const tableName = tableMatch ? tableMatch[1] : 'table';
        return `Create new data table named ${tableName}`;
    }
    
    // DROP TABLE parsing
    if (cleanSQL.includes('drop table')) {
        const tableMatch = cleanSQL.match(/drop\s+table\s+[`"']?(\w+)[`"']?/);
        const tableName = tableMatch ? tableMatch[1] : 'table';
        return `Delete data table named ${tableName}`;
    }
    
    // MongoDB query parsing
    if (database === 'mongodb') {
        if (cleanSQL.includes('.find(')) {
            if (cleanSQL.includes('users')) {
                return 'Query documents from users collection';
            } else if (cleanSQL.includes('orders')) {
                return 'Query documents from orders collection';
            } else {
                return 'Query documents from collection';
            }
        }
        
        if (cleanSQL.includes('.insertone(')) {
            return 'Insert single document into collection';
        }
        
        if (cleanSQL.includes('.updateone(')) {
            return 'Update single document in collection';
        }
        
        if (cleanSQL.includes('.deleteone(') || cleanSQL.includes('.deletemany(')) {
            return 'Delete documents from collection';
        }
        
        if (cleanSQL.includes('.aggregate(')) {
            return 'Execute aggregation query on collection';
        }
    }
    
    // Default return
    return `Execute database operation: ${sql.substring(0, 50)}${sql.length > 50 ? '...' : ''}`;
}

// NL2SQL Panel class
class NL2SQLPanel {
    public static currentPanel: NL2SQLPanel | undefined;
    public static readonly viewType = 'nl2sql';

    public readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _context: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If panel already exists, show it
        if (NL2SQLPanel.currentPanel) {
            NL2SQLPanel.currentPanel._panel.reveal(column);
            return;
        }

        // Otherwise, create new panel
        const panel = vscode.window.createWebviewPanel(
            NL2SQLPanel.viewType,
            'NL2SQL Converter',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        NL2SQLPanel.currentPanel = new NL2SQLPanel(panel, extensionUri, context);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;

        // Set webview HTML content
        this._update();

        // Listen for panel disposal events
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'convert':
                        try {
                            // Get the selected database identifier
                            let databaseId = message.selectedDb || message.database || 'car_1';
                            const providedSchema = Array.isArray(message.schema) ? (message.schema as SQLiteTable[]) : [];
                            
                            console.log('🔍 NL2SQL Panel Convert Request:');
                            console.log('  - Selected DB (message.selectedDb):', message.selectedDb);
                            console.log('  - Fallback DB (message.database):', message.database);
                            console.log('  - Initial Database ID:', databaseId);
                            console.log('  - Input text:', message.text);
                            console.log('  - Schema tables count:', providedSchema.length);
                            
                            // 检测是否是文件路径（包含路径分隔符或.sqlite扩展名）
                            const isFilePath = databaseId.includes('\\') || databaseId.includes('/') || 
                                             databaseId.endsWith('.sqlite') || databaseId.endsWith('.db') || 
                                             databaseId.endsWith('.sqlite3');

                            // Prefer schema-only flow: build schema locally and avoid uploading sqlite to server.
                            if (isFilePath) {
                                databaseId = path.basename(databaseId, path.extname(databaseId));
                            }

                            let schemaDict: DailSchemaDict | null = null;
                            let cvLink: CvLink | null = null;
                            let backendTokens: string[] | undefined = undefined;
                            if (providedSchema.length > 0) {
                                schemaDict = buildDailSchemaFromTables(databaseId, providedSchema);
                                this._panel.webview.postMessage({
                                    command: 'status',
                                    message: `✅ 使用本地提取 schema（${providedSchema.length} 张表）`
                                });

                                if (isFilePath && message.selectedDb && fs.existsSync(message.selectedDb)) {
                                    try {
                                        this._panel.webview.postMessage({
                                            command: 'status',
                                            message: '🔍 生成本地 CV Link 数据...'
                                        });

                                        // 1) 从后台获取一致 token 序列
                                        try {
                                            const dalConfig = vscode.workspace.getConfiguration('nl2sql');
                                            const dalApiUrl = dalConfig.get<string>('dailsql.apiUrl') || 'http://localhost:8000';
                                            const tokenizeResp = await axios.post(
                                                `${dalApiUrl}/api/v1/tokenize`,
                                                {
                                                    question: message.text,
                                                    database_id: databaseId,
                                                    schema: schemaDict
                                                },
                                                { timeout: 60000 }
                                            );

                                            if (tokenizeResp.data?.success && Array.isArray(tokenizeResp.data.question_for_copying)) {
                                                backendTokens = tokenizeResp.data.question_for_copying;
                                                console.log('✅ [tokenize] backend tokens obtained', backendTokens);
                                            } else {
                                                console.warn('⚠️ [tokenize] no backend tokens returned, fallback to frontend tokenize', tokenizeResp.data);
                                            }
                                        } catch (tokenizeErr) {
                                            console.warn('⚠️ [tokenize] failed to fetch backend tokens', tokenizeErr);
                                        }

                                        // 2) 使用后端 token 生成CV Link；如果不存在则退回前端本地tokenizer
                                        cvLink = await buildCvLinkFromLocalSQLite(message.text, message.selectedDb, schemaDict, providedSchema, backendTokens);

                                        this._panel.webview.postMessage({
                                            command: 'status',
                                            message: `✅ 已生成 local cv_link，匹配项 ${Object.keys(cvLink.cell_match).length} 条` 
                                        });
                                    } catch (err) {
                                        console.warn('Failed to build cv_link from local sqlite:', err);
                                        cvLink = null;
                                    }
                                }
                            }
                            
                            // Legacy fallback: only upload sqlite if no schema is available.
                            if (!schemaDict && isFilePath && message.selectedDb && fs.existsSync(message.selectedDb)) {
                                console.log('🔍 Detected SQLite file path, uploading to DAIL-SQL server...');
                                this._panel.webview.postMessage({ 
                                    command: 'status', 
                                    message: '正在上传数据库文件...' 
                                });
                                
                                try {
                                    // Extract a clean database ID from the filename
                                    const fileName = path.basename(message.selectedDb, path.extname(message.selectedDb));
                                    console.log('  - Extracted filename:', fileName);
                                    
                                    // Upload the database file (or reuse existing one)
                                    const uploadedDbId = await uploadSQLiteToDailSQL(message.selectedDb, fileName);
                                    console.log('✅ Database ready. Database ID:', uploadedDbId);
                                    
                                    // Use the returned database ID instead of the file path
                                    databaseId = uploadedDbId;
                                    
                                    this._panel.webview.postMessage({ 
                                        command: 'status', 
                                        message: `数据库已就绪: ${uploadedDbId}` 
                                    });
                                } catch (uploadError) {
                                    console.error('❌ Failed to prepare database:', uploadError);
                                    this._panel.webview.postMessage({ 
                                        command: 'result', 
                                        sql: `-- Error: Failed to prepare database\n-- ${(uploadError as Error).message}\n-- Please check the file path and server connection.` 
                                    });
                                    return;
                                }
                            }
                            
                            console.log('  - Final Database ID for API:', databaseId);

                            // ── NEW: Copilot-based pipeline ──────────────────────────────────
                            // 1. Ask server to build the DAIL-SQL prompt
                            const dalConfig = vscode.workspace.getConfiguration('nl2sql');
                            const dalApiUrl = dalConfig.get<string>('dailsql.apiUrl') || 'http://localhost:8000';

                            this._panel.webview.postMessage({ command: 'status', message: '🔄 Generating prompt from server...' });

                            // Get few-shot counts from webview message (source of truth)
                            const rawHistoryCount = Number(message.historyFewShotCount);
                            const rawGeneralCount = Number(message.generalFewShotCount);
                            const history_count = Number.isFinite(rawHistoryCount) ? Math.max(0, Math.min(10, rawHistoryCount)) : 1;
                            const general_count = Number.isFinite(rawGeneralCount) ? Math.max(0, Math.min(10, rawGeneralCount)) : 3;
                            console.log('🎯 [DEBUG] Few-shot counts from message:', {
                                history_count,
                                general_count,
                                rawHistoryCount: message.historyFewShotCount,
                                rawGeneralCount: message.generalFewShotCount
                            });

                            const generatePromptPayload: any = {
                                question: message.text,
                                database_id: databaseId,
                                k_shot: general_count
                            };

                            const userFewShotPool = this._loadUserFewShotPool();
                            console.log('🎯 [DEBUG] User few-shot pool status:', { 
                                pool_size: userFewShotPool.length,
                                history_count,
                                general_count
                            });
                            
                            // IMPORTANT: Always send user_fewshot_count even if pool is empty
                            // Backend needs this to know user's preference
                            if (history_count > 0 || userFewShotPool.length > 0) {
                                generatePromptPayload.user_fewshots = userFewShotPool;
                                generatePromptPayload.user_fewshot_count = history_count;
                                console.log('📚 Include user few-shot in request', {
                                    total_pool: userFewShotPool.length,
                                    requested_count: history_count,
                                    general_count,
                                    database_id: databaseId
                                });
                            } else {
                                console.log('⊘ User few-shot count is 0, skipping user fewshots');
                            }
                            if (schemaDict) {
                                generatePromptPayload.schema = schemaDict;
                            }

                            if (cvLink) {
                                generatePromptPayload.cv_link = cvLink;
                                console.log('🔍 [cv_link] sending to server', {
                                    num_date_match_count: Object.keys(cvLink.num_date_match).length,
                                    cell_match_count: Object.keys(cvLink.cell_match).length,
                                    cvLink,
                                    generatePromptPayload
                                });
                            } else {
                                console.warn('⚠️ [cv_link] missing from frontend, cvLink = null');
                            }

                            if (backendTokens && backendTokens.length > 0) {
                                generatePromptPayload.question_for_copying = backendTokens;
                                console.log('🔧 [tokenization] include question_for_copying in generate-prompt payload', backendTokens);
                            }

                            const promptResp = await axios.post(
                                `${dalApiUrl}/api/v1/generate-prompt`,
                                generatePromptPayload,
                                { timeout: 120000 }
                            );

                            if (!promptResp.data?.success) {
                                throw new Error(promptResp.data?.error || 'Server failed to generate prompt');
                            }

                            const selectedExamples = Array.isArray(promptResp.data?.debug_info?.selected_examples)
                                ? promptResp.data.debug_info.selected_examples
                                : [];
                            await this._incrementFewShotCallCounts(selectedExamples);

                            const dalSessionId: string = promptResp.data.session_id;
                            let copilotPrompt: string = promptResp.data.prompt;

                            // 2. Pick the Copilot model selected by the user
                            const requestedModelId: string = message.copilotModelId || '';
                            let lmModels: vscode.LanguageModelChat[];
                            try {
                                lmModels = await vscode.lm.selectChatModels(
                                    requestedModelId
                                        ? { id: requestedModelId }
                                        : { vendor: 'copilot' }
                                );
                            } catch (lmErr) {
                                throw new Error('Cannot access GitHub Copilot Language Model API. Make sure GitHub Copilot is installed and you are signed in.');
                            }

                            if (lmModels.length === 0) {
                                throw new Error('No GitHub Copilot models available. Please ensure GitHub Copilot is installed and signed in.');
                            }

                            const lmModel = lmModels[0];
                            console.log(`🤖 Using Copilot model: ${lmModel.name} (${lmModel.id})`);

                            // 3. Generation + validation loop
                            const maxAttempts = 3;
                            let finalSql = '';

                            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                                this._panel.webview.postMessage({
                                    command: 'status',
                                    message: `🤖 Asking Copilot (${lmModel.name}) – attempt ${attempt}/${maxAttempts}...`
                                });

                                const cts = new vscode.CancellationTokenSource();
                                let rawSql = '';
                                try {
                                    const lmResp = await lmModel.sendRequest(
                                        [vscode.LanguageModelChatMessage.User(copilotPrompt)],
                                        {},
                                        cts.token
                                    );
                                    for await (const chunk of lmResp.stream) {
                                        if (chunk instanceof vscode.LanguageModelTextPart) {
                                            rawSql += chunk.value;
                                        }
                                    }
                                } finally {
                                    cts.dispose();
                                }

                                console.log(`📝 Copilot raw response (attempt ${attempt}):`, rawSql.substring(0, 200));

                                // Strip markdown code fences that Copilot often adds (e.g. ```sql ... ```)
                                rawSql = rawSql.replace(/^```(?:sql)?\s*/i, '').replace(/```\s*$/, '').trim();

                                // 4. Send SQL to server for validation
                                this._panel.webview.postMessage({
                                    command: 'status',
                                    message: `🔍 Validating SQL (attempt ${attempt}/${maxAttempts})...`
                                });

                                const validateResp = await axios.post(
                                    `${dalApiUrl}/api/v1/validate-sql`,
                                    {
                                        session_id: dalSessionId,
                                        sql: rawSql,
                                        attempt: attempt,
                                        max_attempts: maxAttempts,
                                        ...(schemaDict ? { schema: schemaDict } : {}),
                                        ...(cvLink ? { cv_link: cvLink } : {}),
                                        ...(backendTokens && backendTokens.length > 0 ? { question_for_copying: backendTokens } : {})
                                    },
                                    { timeout: 30000 }
                                );

                                if (validateResp.data?.valid) {
                                    finalSql = validateResp.data.sql || rawSql;
                                    console.log('✅ SQL validation passed on attempt', attempt);
                                    break;
                                } else if (validateResp.data?.next_prompt && attempt < maxAttempts) {
                                    // Server returned a corrective prompt – use it for the next Copilot call
                                    copilotPrompt = validateResp.data.next_prompt;
                                    this._panel.webview.postMessage({
                                        command: 'status',
                                        message: `⚠️ SQL invalid, sending correction prompt to Copilot...`
                                    });
                                } else {
                                    // No more retries or no next_prompt – use best-effort result
                                    finalSql = rawSql;
                                    console.warn('⚠️ SQL validation failed, using best-effort result');
                                    break;
                                }
                            }

                            // 执行SQLite查询（如果是SQLite数据库）
                            let executionResults = undefined;
                            if (message.database === 'sqlite' || message.selectedDb) {
                                try {
                                    if (fs.existsSync(message.selectedDb)) {
                                        executionResults = await executeSQL(message.selectedDb, finalSql || '');
                                    }
                                } catch (execError) {
                                    console.warn('⚠️ Failed to execute SQLite query:', execError);
                                    // 不中断流程，只是提示执行失败
                                }
                            }

                            this._panel.webview.postMessage({
                                command: 'result',
                                sql: finalSql || '-- No SQL was generated',
                                results: executionResults
                            });
                            // ── end Copilot-based pipeline ───────────────────────────────────

                        } catch (error) {
                            console.error('❌ Convert error:', error);
                            this._panel.webview.postMessage({ 
                                command: 'result', 
                                sql: `-- Error during conversion\n-- ${(error as Error).message}`,
                                results: undefined
                            });
                        }
                        return;
                    case 'executeSQL':
                        try {
                            let executionResults = undefined;
                            if (message.type === 'sqlite' && message.database && message.sql) {
                                try {
                                    executionResults = await executeSQL(message.database, message.sql);
                                } catch (execError) {
                                    console.warn('⚠️ Failed to execute SQLite query:', execError);
                                    this._panel.webview.postMessage({ command: 'result', sql: message.sql, results: undefined });
                                    return;
                                }
                            } else {
                                console.warn('⚠️ executeSQL only supports SQLite currently: ', message.type);
                            }
                            this._panel.webview.postMessage({ command: 'result', sql: message.sql || '-- No SQL was provided', results: executionResults });
                        } catch (error) {
                            console.error('❌ executeSQL error:', error);
                            this._panel.webview.postMessage({ command: 'result', sql: message.sql || '-- No SQL was provided', results: undefined });
                        }
                        return;
                    case 'loadFewShot':
                        try {
                            const storagePath = this._context.globalStorageUri.fsPath;
                            const poolFile = path.join(storagePath, 'fewshot_pool.json');
                            let pool: any[] = [];
                            if (fs.existsSync(poolFile)) {
                                const content = fs.readFileSync(poolFile, 'utf8');
                                pool = content ? JSON.parse(content) : [];
                                if (!Array.isArray(pool)) pool = [];
                            }
                            this._panel.webview.postMessage({ command: 'fewShotLoaded', pool});
                        } catch (err) {
                            console.error('Error loading few shot pool:', err);
                            this._panel.webview.postMessage({ command: 'fewShotLoaded', pool: [], error: (err as Error).message || 'Read failed' });
                        }
                        return;
                    case 'saveFewShot':
                        let poolFile = '';
                        try {
                            const record = message.record || {};
                            const nlqText = String(record.nlq || '');
                            const sqlText = String(record.sql || '');
                            const dbId = String(record.db_id || record.database || 'unknown');

                            // Try to generate embedding at backend and attach
                            const dalConfig = vscode.workspace.getConfiguration('nl2sql');
                            const dalApiUrl = dalConfig.get<string>('dailsql.apiUrl') || 'http://localhost:8000';
                            let embedding: number[] | undefined;

                            try {
                                const embedResp = await axios.post(
                                    `${dalApiUrl}/api/v1/encode`,
                                    { texts: [nlqText] },
                                    { timeout: 30000 }
                                );

                                if (embedResp.data?.success && Array.isArray(embedResp.data.embeddings) && embedResp.data.embeddings[0]) {
                                    embedding = embedResp.data.embeddings[0];
                                } else {
                                    console.warn('Failed to fetch embedding for few-shot', embedResp.data);
                                }
                            } catch (embedErr) {
                                console.warn('Error calling backend embedding endpoint:', embedErr);
                            }

                            const storagePath = this._context.globalStorageUri.fsPath;
                            if (!fs.existsSync(storagePath)) {
                                fs.mkdirSync(storagePath, { recursive: true });
                            }

                            const poolFilePath = path.join(storagePath, 'fewshot_pool.json');
                            let pool: any[] = [];
                            if (fs.existsSync(poolFilePath)) {
                                try {
                                    const content = fs.readFileSync(poolFilePath, 'utf8');
                                    pool = content ? JSON.parse(content) : [];
                                    if (!Array.isArray(pool)) pool = [];
                                } catch (innerErr) {
                                    console.warn('Failed to parse existing fewshot pool, overwriting', innerErr);
                                    pool = [];
                                }
                            }

                            const nextIndex = pool.length > 0 ? Math.max(...pool.map((item: any) => Number(item.index) || 0)) + 1 : 1;
                            const dataEntry: any = {
                                index: nextIndex,
                                nlq: nlqText,
                                sql: sqlText,
                                db_id: dbId,
                                created_at: new Date().toISOString(),
                                call_count: 0
                            };
                            if (embedding) {
                                dataEntry.embedding = embedding;
                            }

                            pool.push(dataEntry);

                            const MAX_FEWSHOT_POOL_SIZE = 100;
                            if (pool.length > MAX_FEWSHOT_POOL_SIZE) {
                                pool.sort((a: any, b: any) => {
                                    const aCount = Math.max(0, Number(a?.call_count) || 0);
                                    const bCount = Math.max(0, Number(b?.call_count) || 0);
                                    if (aCount !== bCount) return aCount - bCount;

                                    const aTime = Date.parse(String(a?.created_at || '')) || 0;
                                    const bTime = Date.parse(String(b?.created_at || '')) || 0;
                                    return aTime - bTime;
                                });

                                const removeCount = pool.length - MAX_FEWSHOT_POOL_SIZE;
                                const removed = pool.splice(0, removeCount);
                                console.log('🧹 Few-shot pool pruned to 100 records', {
                                    removed: removed.length,
                                    removed_summary: removed.map((r: any) => ({ index: r?.index, call_count: r?.call_count }))
                                });
                            }

                            fs.writeFileSync(poolFilePath, JSON.stringify(pool, null, 2), 'utf8');

                            this._panel.webview.postMessage({ command: 'fewShotSaved', success: true, index: nextIndex, entry: dataEntry, path: poolFilePath });
                        } catch (err) {
                            console.error('Error saving few shot pool:', err);
                            this._panel.webview.postMessage({ command: 'fewShotSaved', success: false, path: poolFile, error: (err as Error).message || 'Write failed' });
                        }
                        return;
                    case 'getModels':
                        try {
                            const availableModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
                            const modelList = availableModels.map(m => ({ id: m.id, name: m.name || m.id }));
                            console.log('📋 Available Copilot models:', modelList);
                            this._panel.webview.postMessage({ command: 'copilotModels', models: modelList });
                        } catch (e) {
                            console.error('Failed to fetch Copilot models:', e);
                            this._panel.webview.postMessage({ command: 'copilotModels', models: [] });
                        }
                        return;
                    case 'reverse':
                        const nlResult = await convertSQLToNaturalLanguage(message.sql, message.database || 'sqlite');
                        this._panel.webview.postMessage({ command: 'nlResult', text: nlResult });
                        return;
                    case 'getDatabases':
                        if (message.type === 'sqlite') {
                            try {
                                const sqliteFiles = await findSQLiteFiles();
                                const databases = sqliteFiles.map(filePath => {
                                    const fileName = path.basename(filePath);
                                    // Remove extension for display name but keep full path for value
                                    const displayName = fileName.replace(/\.(db|sqlite|sqlite3)$/i, '');
                                    return {
                                        name: displayName,
                                        path: filePath
                                    };
                                });
                                this._panel.webview.postMessage({ command: 'databases', databases });
                            } catch (error) {
                                console.error('Error finding SQLite files:', error);
                                this._panel.webview.postMessage({ command: 'databases', databases: [] });
                            }
                        } else if (message.type === 'mysql') {
                            try {
                                console.log('Getting MySQL databases...');
                                const mysqlConfig = await getMySQLConfig(this._context);
                                console.log('MySQL config:', mysqlConfig ? 'found' : 'not found');
                                if (mysqlConfig) {
                                    const databases = await getMySQLDatabases(mysqlConfig);
                                    console.log('MySQL databases:', databases);
                                    this._panel.webview.postMessage({ command: 'databases', databases: databases.map(name => ({ name, path: name })) });
                                } else {
                                    console.log('MySQL not configured, sending error message');
                                    this._panel.webview.postMessage({ command: 'databases', databases: [], error: 'MySQL not configured. Please configure MySQL connection first.' });
                                }
                            } catch (error) {
                                console.error('Error getting MySQL databases:', error);
                                this._panel.webview.postMessage({ command: 'databases', databases: [], error: 'Error connecting to MySQL: ' + (error as Error).message });
                            }
                        }
                        return;
                    case 'getSchema':
                        try {
                            if (message.type === 'sqlite' && message.database && 
                                (message.database.endsWith('.db') || 
                                 message.database.endsWith('.sqlite') || 
                                 message.database.endsWith('.sqlite3'))) {
                                const schema = await readSQLiteSchema(message.database);
                                this._panel.webview.postMessage({ command: 'schema', schema });
                            } else if (message.type === 'mysql' && message.database) {
                                const mysqlConfig = await getMySQLConfig(this._context);
                                if (mysqlConfig) {
                                    mysqlConfig.database = message.database;
                                    const schema = await readMySQLSchema(mysqlConfig);
                                    this._panel.webview.postMessage({ command: 'schema', schema });
                                } else {
                                    this._panel.webview.postMessage({ command: 'schema', schema: [], error: 'MySQL not configured' });
                                }
                            } else {
                                this._panel.webview.postMessage({ command: 'schema', schema: [], error: 'Invalid database path for schema' });
                            }
                        } catch (error) {
                            console.error('Error reading schema:', error);
                            this._panel.webview.postMessage({ command: 'schema', schema: [], error: 'Error reading schema: ' + (error as Error).message });
                        }
                        return;
                    case 'getTableData':
                        try {
                            let rows = [];
                            if (message.type === 'sqlite' && message.database) {
                                const table = message.table;
                                const safeName = quoteIdentifier(table);
                                const sql = `SELECT * FROM ${safeName} LIMIT 100`;
                                rows = await executeSQL(message.database, sql);
                            } else {
                                // MySQL数据读取暂不支持，回传空信息
                                rows = [];
                            }
                            this._panel.webview.postMessage({ command: 'tableData', table: message.table, rows });
                        } catch (error) {
                            console.error('Error loading table data:', error);
                            this._panel.webview.postMessage({ command: 'tableData', table: message.table, rows: [] });
                        }
                        return;
                    case 'configureMySQL':
                        vscode.commands.executeCommand('nl2sql.configureMysql');
                        return;
                    case 'uploadDatabase':
                        vscode.commands.executeCommand('nl2sql.uploadDatabase');
                        return;
                    case 'convertWithCustomDB':
                        try {
                            const result = await convertNaturalLanguageToSQL(message.question, message.database_id);
                            this._panel.webview.postMessage({ 
                                command: 'conversionResult', 
                                result: result,
                                question: message.question,
                                database: message.database_id
                            });
                        } catch (error) {
                            this._panel.webview.postMessage({ 
                                command: 'conversionError', 
                                error: (error as Error).message 
                            });
                        }
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    private _loadUserFewShotPool(): UserFewShotRecord[] {
        try {
            const storagePath = this._context.globalStorageUri.fsPath;
            const poolFile = path.join(storagePath, 'fewshot_pool.json');
            if (!fs.existsSync(poolFile)) {
                return [];
            }

            const content = fs.readFileSync(poolFile, 'utf8');
            const raw = content ? JSON.parse(content) : [];
            if (!Array.isArray(raw)) {
                return [];
            }

            return raw
                .filter((item: any) => item && typeof item === 'object')
                .map((item: any) => ({
                    index: Number(item.index) || undefined,
                    nlq: String(item.nlq || ''),
                    sql: String(item.sql || ''),
                    db_id: String(item.db_id || item.database_id || item.database || ''),
                    created_at: item.created_at ? String(item.created_at) : undefined,
                    embedding: Array.isArray(item.embedding) ? item.embedding : undefined,
                    call_count: Math.max(0, Number(item.call_count) || 0),
                }))
                .filter((item: UserFewShotRecord) => item.nlq.trim().length > 0 && item.sql.trim().length > 0 && item.db_id.trim().length > 0);
        } catch (error) {
            console.warn('Failed to load user few-shot pool from global storage:', error);
            return [];
        }
    }

    private async _incrementFewShotCallCounts(selectedExamples: any[]): Promise<void> {
        try {
            if (!Array.isArray(selectedExamples) || selectedExamples.length === 0) {
                return;
            }

            const selectedUserExamples = selectedExamples.filter((example: any) => example?.source === 'user_memory');
            if (selectedUserExamples.length === 0) {
                return;
            }

            const storagePath = this._context.globalStorageUri.fsPath;
            const poolFile = path.join(storagePath, 'fewshot_pool.json');
            if (!fs.existsSync(poolFile)) {
                return;
            }

            const content = fs.readFileSync(poolFile, 'utf8');
            const pool: any[] = content ? JSON.parse(content) : [];
            if (!Array.isArray(pool) || pool.length === 0) {
                return;
            }

            let updatedCount = 0;
            for (const selected of selectedUserExamples) {
                const selectedIndex = Number(selected?.user_index);
                const selectedNlq = String(selected?.question || '').trim();
                const selectedSql = String(selected?.query || '').trim();

                const matched = pool.find((item: any) => {
                    if (Number.isFinite(selectedIndex) && selectedIndex > 0 && Number(item?.index) === selectedIndex) {
                        return true;
                    }
                    return String(item?.nlq || '').trim() === selectedNlq && String(item?.sql || '').trim() === selectedSql;
                });

                if (matched) {
                    matched.call_count = Math.max(0, Number(matched.call_count) || 0) + 1;
                    updatedCount += 1;
                }
            }

            if (updatedCount > 0) {
                fs.writeFileSync(poolFile, JSON.stringify(pool, null, 2), 'utf8');
                console.log('📈 Updated few-shot call counts', { updatedCount });
            }
        } catch (error) {
            console.warn('Failed to update few-shot call counts:', error);
        }
    }

    public dispose() {
        NL2SQLPanel.currentPanel = undefined;

        // Clean up resources
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NL2SQL Converter</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
            height: 100vh;
            display: flex;
            background-color: #1e1e1e; /* 纯黑灰背景 */
            color: #e0e0e0; /* 浅灰色文字 */
            padding: 20px;
            gap: 20px;
        }
        /* 左侧面板 */
        .left-panel {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }
        /* 新增：数据库相关模块的横向容器 */
        .db-row-container {
            display: flex;
            gap: 20px;
            width: 100%;
        }
        /* 调整卡片宽度为平分 */
        .db-engine-card {
            flex: 1;
        }
        .db-select-card {
            flex: 2; /* Database模块宽度稍大，因为内容更多 */
        }
        .card {
            background-color: #2d2d2d; /* 深灰色卡片背景 */
            border-radius: 12px;
            padding: 20px;
            border: 1px solid #3d3d3d; /* 灰色边框 */
        }
        .card h3 {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 10px;
            color: #f0f0f0; /* 更亮的灰色标题 */
        }
        .card p {
            font-size: 13px;
            color: #b0b0b0; /* 中灰色说明文字 */
            margin-bottom: 15px;
            line-height: 1.4;
        }
        /* 下拉选择框通用样式 */
        select {
            width: 100%;
            padding: 10px 12px;
            background-color: #1e1e1e;
            color: #e0e0e0;
            border: 1px solid #4d4d4d; /* 灰色边框 */
            border-radius: 8px;
            font-size: 14px;
            appearance: none;
            cursor: pointer;
        }
        select:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        /* 数据库搜索选择器 */
        .database-search {
            position: relative;
            width: 100%;
        }
        .database-search input {
            width: 100%;
            padding: 10px 12px;
            background-color: #1e1e1e;
            color: #e0e0e0;
            border: 1px solid #4d4d4d;
            border-radius: 8px;
            font-size: 14px;
            outline: none;
        }
        .database-dropdown {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background-color: #1e1e1e;
            border: 1px solid #4d4d4d;
            border-top: none;
            border-radius: 0 0 8px 8px;
            max-height: 200px;
            overflow-y: auto;
            z-index: 1000;
            display: none;
        }
        .database-option {
            padding: 8px 12px;
            cursor: pointer;
            color: #e0e0e0;
            font-size: 14px;
        }
        .database-option:hover {
            background-color: #3d3d3d; /* 灰色hover效果 */
        }
        .database-option.selected {
            background-color: #6d6d6d; /* 灰色选中效果 */
            color: #ffffff;
        }
        /* 数据库操作按钮组 */
        .db-actions {
            display: flex;
            gap: 10px;
            margin-top: 10px;
        }
        .db-btn {
            padding: 8px 16px;
            background-color: #3d3d3d; /* 灰色按钮 */
            color: #e0e0e0;
            border: none;
            border-radius: 8px;
            font-size: 13px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .db-btn.primary {
            background-color: #6d6d6d; /* 浅灰色主按钮 */
            color: #ffffff;
        }
        /* Model选择器卡片 - 独立模块样式 */
        .model-card-container {
            background-color: #2d2d2d; /* 与其他卡片一致的深灰色背景 */
            border-radius: 12px;
            padding: 20px;
            border: 1px solid #3d3d3d;
        }
        /* 并排布局：AI Model 和 FewShot Setting */
        .model-config-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
            margin-top: 10px;
        }
        .model-card {
            padding: 15px;
            background-color: #1e1e1e;
            border-radius: 8px;
            border: 1px solid #4d4d4d;
        }
        .model-card label {
            display: block;
            margin-bottom: 8px;
            font-size: 13px;
            color: #b0b0b0; /* 中灰色标签文字 */
        }
        /* FewShot设置卡片 */
        .fewshot-setting-card {
            padding: 15px;
            background-color: #1e1e1e;
            border-radius: 8px;
            border: 1px solid #4d4d4d;
        }
        .fewshot-setting-card label {
            display: block;
            margin-bottom: 12px;
            font-size: 13px;
            color: #b0b0b0;
            font-weight: 500;
        }
        .fewshot-controls {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .fewshot-control-group {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .fewshot-control-group label {
            display: inline;
            margin: 0;
            font-size: 12px;
            color: #a0a0a0;
            min-width: 130px;
        }
        .fewshot-control-group input[type="number"] {
            width: 60px;
            padding: 6px 8px;
            background-color: #2d2d2d;
            color: #e0e0e0;
            border: 1px solid #4d4d4d;
            border-radius: 4px;
            font-size: 12px;
            text-align: center;
        }
        .fewshot-control-group input[type="number"]:focus {
            outline: none;
            border-color: #0e639c;
            background-color: #3d3d3d;
        }
        .fewshot-label {
            font-size: 11px;
            color: #808080;
        }
        /* 输入框 */
        .input-wrapper {
            position: relative;
        }
        textarea {
            width: 100%;
            min-height: 220px;
            padding: 12px;
            background-color: #1e1e1e;
            color: #e0e0e0;
            border: 1px solid #4d4d4d;
            border-radius: 8px;
            font-size: 14px;
            resize: none;
            outline: none;
            line-height: 1.5;
        }
        .char-count {
            position: absolute;
            right: 12px;
            bottom: 12px;
            font-size: 12px;
            color: #808080; /* 深灰色字符计数 */
        }
        /* 右侧面板 */
        .right-panel {
            flex: 1;
            display: flex;
            flex-direction: column;
        }
        .output-card {
            flex: 1;
            background-color: #2d2d2d;
            border-radius: 12px;
            padding: 20px;
            border: 1px solid #3d3d3d;
            display: flex;
            flex-direction: column;
        }
        .output-card h3 {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 15px;
            color: #f0f0f0;
        }
        /* Output分成两部分的容器 */
        .output-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 15px;
            overflow: hidden;
        }
        /* 上部：SQL代码区 */
        .sql-code-section {
            flex: 0.6;
            display: flex;
            flex-direction: column;
        }
        .sql-code-section h4 {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 8px;
            color: #ffffff;
        }
        .sql-output {
            flex: 1;
            background-color: #1e1e1e;
            border: 1px solid #4d4d4d;
            border-radius: 8px;
            padding: 15px;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 13px;
            color: #b0b0b0;
            overflow-y: auto;
            white-space: pre-wrap;
            line-height: 1.6;
            word-break: break-word;
        }
        /* SQL语法高亮颜色 */
        .sql-keyword {
            color: #569cd6; /* 蓝色 - 关键字 */
            font-weight: bold;
        }
        .sql-string {
            color: #ce9178; /* 橙色 - 字符串 */
        }
        .sql-number {
            color: #b5cea8; /* 绿色 - 数字 */
        }
        .sql-function {
            color: #dcdcaa; /* 黄色 - 函数 */
        }
        .sql-comment {
            color: #6a9955; /* 绿灰色 - 注释 */
            font-style: italic;
        }
        /* 下部：执行结果区 */
        .results-section {
            flex: 0.4;
            display: flex;
            flex-direction: column;
            min-height: 150px;
        }
        .results-section h4 {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 8px;
            color: #ffffff;
        }
        .results-output {
            flex: 1;
            background-color: #1e1e1e;
            border: 1px solid #4d4d4d;
            border-radius: 8px;
            padding: 12px;
            overflow: auto;
            font-size: 13px;
        }
        /* 结果表格样式 */
        .results-table {
            width: 100%;
            border-collapse: collapse;
            color: #e0e0e0;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 12px;
        }
        .results-table thead {
            background-color: #3d3d3d;
            border-bottom: 2px solid #4d4d4d;
        }
        .results-table th {
            padding: 8px;
            text-align: left;
            color: #ffffff;
            font-weight: 600;
        }
        .results-table td {
            padding: 6px 8px;
            border-bottom: 1px solid #4d4d4d;
        }
        .results-table tbody tr:hover {
            background-color: #2d2d2d;
        }
        .results-table tbody tr:nth-child(even) {
            background-color: #252525;
        }
        /* Database Detail 样式 */
        .db-detail-container {
            display: flex;
            flex-direction: column; /* 上下结构 */
            gap: 10px;
            flex: 1;
            min-height: 0;
        }
        #dbDetailCard {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
            overflow: hidden;
        }
        .db-detail-tables {
            background-color: #1e1e1e;
            border: 1px solid #4d4d4d;
            border-radius: 8px;
            padding: 10px;
            max-height: 130px;
            overflow-x: auto;
            overflow-y: hidden;
            white-space: nowrap; /* 横向滚动 */
            display: flex;
            gap: 8px;
        }
        .db-detail-info {
            flex: 1;
            background-color: #1e1e1e;
            border: 1px solid #4d4d4d;
            border-radius: 8px;
            padding: 10px;
            overflow: hidden;
            min-height: 0;
            display: flex;
            flex-direction: column;
        }
        .db-detail-table-item {
            cursor: pointer;
            padding: 6px 12px;
            border-radius: 6px;
            margin-bottom: 0;
            color: #e0e0e0;
            white-space: nowrap;
            border: 1px solid #3d3d3d;
            display: inline-flex;
            align-items: center;
        }
        .db-detail-rows {
            margin-top: 10px;
            flex: 1;
            min-height: 0;
            overflow-y: auto;
        }
        .db-detail-table-item.selected {
            background-color: #3d3d3d;
            font-weight: bold;
        }
        .db-detail-columns {
            margin-bottom: 8px;
        }
        .db-detail-columns span {
            display: inline-block;
            background-color: #2d2d2d;
            border: 1px solid #3d3d3d;
            border-radius: 4px;
            padding: 2px 6px;
            margin: 3px 3px 3px 0;
            font-size: 12px;
        }
        /* 结果信息提示 */
        .results-info {
            color: #b0b0b0;
            font-size: 13px;
            padding: 12px;
            text-align: center;
        }
        .results-error {
            color: #f48771;
            font-size: 13px;
            padding: 12px;
        }
        /* 底部操作栏 */
        .action-bar {
            margin-top: 15px;
            display: flex;
            gap: 10px;
            justify-content: flex-end;
        }
        .convert-btn {
            padding: 10px 24px;
            background-color: #6d6d6d; /* 浅灰色转换按钮 */
            color: #ffffff;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
        }
        .clear-btn {
            padding: 10px 24px;
            background-color: #3d3d3d; /* 深灰色清空按钮 */
            color: #e0e0e0;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            cursor: pointer;
        }
        /* 响应式适配：小屏幕时恢复垂直布局 */
        @media (max-width: 768px) {
            .db-row-container {
                flex-direction: column;
            }
            .db-engine-card, .db-select-card {
                flex: none;
                width: 100%;
            }
        }
    </style>
    <!-- Prism 代码高亮 -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/prismjs/themes/prism-tomorrow.css" />
    <script src="https://cdn.jsdelivr.net/npm/prismjs/prism.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/prismjs/components/prism-sql.min.js"></script>
</head>
<body>
    <!-- 左侧面板 -->
    <div class="left-panel">
        <!-- 新增：横向容器包裹Database Engine和Database模块 -->
        <div class="db-row-container">
            <!-- 数据库引擎选择 -->
            <div class="card db-engine-card">
                <h3>Database Engine*</h3>
                <p>Please select your database engine</p>
                <select id="dbTypeSelect" onchange="onDatabaseTypeChange()">
                    <option value="mysql">MySQL</option>
                    <option value="sqlite">SQLite</option>
                </select>
            </div>

            <!-- 数据库选择 -->
            <div class="card db-select-card">
                <h3>Database*</h3>
                <p>Select a database to use</p>
                <div class="database-search" id="dbSearchContainer">
                    <input type="text" id="dbSearchInput" placeholder="Search database..." autocomplete="off" />
                    <div class="database-dropdown" id="dbDropdown"></div>
                </div>
                <div class="db-actions">
                    <button class="db-btn" onclick="refreshDatabases()">🔄 Refresh</button>
                    <button class="db-btn primary" onclick="uploadDatabase()">📤 Upload DB</button>
                    <button class="db-btn" id="mysqlConfigBtn" style="display: none;" onclick="configureMySQL()">⚙️ MySQL Config</button>
                    <button class="db-btn" id="dbDetailBtn" style="display: none;" onclick="toggleDatabaseDetail()">🗃️ Database Detail</button>
                </div>
            </div>
        </div>

        <!-- Model选择器 + FewShot设置：并排布局 -->
        <div class="model-card-container">
            <h3>Configuration*</h3>
            <p>Select AI model and few-shot settings.</p>
            <div class="model-config-row">
                <!-- 左列：AI Model选择器 -->
                <div class="model-card">
                    <label for="copilotModelSelect">🤖 AI Model</label>
                    <select id="copilotModelSelect" title="Select GitHub Copilot model">
                        <option value="">Loading models...</option>
                    </select>
                </div>
                
                <!-- 右列：FewShot Setting -->
                <div class="fewshot-setting-card">
                    <label>📚 FewShot Setting</label>
                    <div class="fewshot-controls">
                        <div class="fewshot-control-group">
                            <label for="historyShotsInput">History Few-Shots:</label>
                            <input type="number" id="historyShotsInput" min="0" max="10" value="1" title="Number of user history few-shots (0-10)">
                            <span class="fewshot-label">/ 10</span>
                        </div>
                        <div class="fewshot-control-group">
                            <label for="generalShotsInput">General Few-Shots:</label>
                            <input type="number" id="generalShotsInput" min="0" max="10" value="3" title="Number of general few-shots (0-10)">
                            <span class="fewshot-label">/ 10</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 数据库详情区（默认隐藏） -->
        <div class="card" id="dbDetailCard" style="display: none;">
            <h3>Database Detail</h3>
            <p>Choose a table to view columns and sample rows.</p>
            <div class="db-detail-container">
                <div class="db-detail-tables" id="dbTablesContainer"></div>
                <div class="db-detail-info" id="dbTableDetails">(Select a table to view columns + row data.)</div>
            </div>
        </div>

        <!-- 输入区 -->
        <div class="card" id="inputCard">
            <h3>Input*</h3>
            <p>Please write your query in no more than 200 characters.</p>
            <div class="input-wrapper">
                <textarea 
                    id="leftInput" 
                    placeholder="Write a SQL that calculates the total sales for a specific product from the orders table..."
                    maxlength="200"
                    oninput="updateCharCount()"
                ></textarea>
                <div class="char-count" id="charCount">0 / 200</div>
            </div>
        </div>
    </div>

    <!-- 右侧面板 -->
    <div class="right-panel">
        <div class="output-card">
            <h3>Output</h3>
            <div class="output-container">
                <!-- 上部：SQL代码区 -->
                <div class="sql-code-section">
                    <h4>📝 SQL Code</h4>
                    <textarea id="rightOutput" class="sql-output" placeholder="-- SQL output will appear here and can be edited..."></textarea>
                </div>
                
                <!-- 下部：执行结果区 -->
                <div class="results-section">
                    <h4>📊 Execution Results</h4>
                    <div id="resultsOutput" class="results-output">
                        <div class="results-info">-- Execute SQL to see results here</div>
                    </div>
                </div>
            </div>
            
            <div class="action-bar">
                <button class="clear-btn" onclick="clearOutput()">🗑️ Clear Output</button>
                <button class="db-btn" onclick="saveFewShot()">💾 Save Few-Shot</button>
                <button class="db-btn" onclick="executeSqlFromOutput()">▶️ Run SQL</button>
                <button class="convert-btn" onclick="performConvert()">🚀 Convert to SQL</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentSchema = null; // Store current database schema
        let allDatabases = []; // Store all available databases
        let selectedDatabase = null; // Store currently selected database
        let modelsLoaded = false; // 标记模型是否已加载
        let dbDetailMode = false; // 标记数据库详情视图是否激活
        let selectedDetailTable = null; // 当前选中详情表

        // 初始化（修复Models加载逻辑）
        document.addEventListener('DOMContentLoaded', function() {
            document.getElementById('leftInput').focus();
            setupDatabaseSearch(); 
            onDatabaseTypeChange(); 
            updateCharCount();
            setupFewShotControls(); // 初始化 few-shot 控制器
            
            // 立即请求模型列表 + 增加重试机制
            fetchCopilotModels();
            
            // 监听扩展消息（提前绑定，避免丢失）
            window.addEventListener('message', handleExtensionMessages);
        });

        // 修复：独立的模型获取函数（增加重试）
        function fetchCopilotModels() {
            if (modelsLoaded) return;
            
            // 发送请求获取模型列表
            vscode.postMessage({ command: 'getModels' });
            
            // 重试机制：如果5秒内未加载成功，再次请求
            setTimeout(() => {
                if (!modelsLoaded) {
                    console.log('Retry fetching Copilot models...');
                    vscode.postMessage({ command: 'getModels' });
                }
            }, 5000);
        }

        // 修复：统一处理扩展消息
        function handleExtensionMessages(event) {
            const message = event.data;
            switch (message.command) {
                case 'result':
                    // 上部：显示SQL代码（可编辑）
                    const outputEl = document.getElementById('rightOutput');
                    const sqlText = message.sql ? message.sql : '-- No SQL generated';
                    if (outputEl && outputEl.tagName === 'TEXTAREA') {
                        outputEl.value = sqlText;
                    } else if (outputEl) {
                        outputEl.textContent = sqlText;
                    }

                    // 下部：显示执行结果或提示
                    if (message.results !== undefined) {
                        if (Array.isArray(message.results) && message.results.length > 0) {
                            renderResultsTable(message.results);
                        } else if (Array.isArray(message.results)) {
                            document.getElementById('resultsOutput').innerHTML = 
                                '<div class="results-info">✅ Query executed successfully. No rows returned.</div>';
                        } else {
                            document.getElementById('resultsOutput').innerHTML = 
                                '<div class="results-info">📧 Ready to execute SQL. Click the convert button first.</div>';
                        }
                    } else {
                        document.getElementById('resultsOutput').innerHTML = 
                            '<div class="results-info">📧 Results will appear here after execution</div>';
                    }
                    break;
                case 'databases':
                    updateDatabaseList(message.databases, message.error);
                    break;
                case 'schema':
                    currentSchema = message.schema;
                    if (message.error) {
                        console.error('Schema error:', message.error);
                    }
                    const dbDetailBtn = document.getElementById('dbDetailBtn');
                    if (selectedDatabase && currentSchema && currentSchema.length > 0) {
                        dbDetailBtn.style.display = 'inline-flex';
                    } else {
                        dbDetailBtn.style.display = 'none';
                    }
                    break;
                case 'refreshDatabases':
                    refreshDatabases();
                    break;
                case 'copilotModels':
                    // 标记模型已加载
                    modelsLoaded = true;
                    updateModelSelector(message.models);
                    break;
                case 'fewShotSaved':
                    if (message.success) {
                        document.getElementById('resultsOutput').innerHTML = '<div class="results-info">Saved few-shot entry #' + message.index + ' successfully. Path: ' + (message.path || 'unknown') + '</div>';
                    } else {
                        document.getElementById('resultsOutput').innerHTML = '<div class="results-error">Save failed: ' + (message.error || 'Unknown error') + '. Path: ' + (message.path || 'unknown') + '</div>';
                    }
                    break;
                case 'fewShotLoaded':
                    if (message.error) {
                        console.error('fewShotLoaded error:', message.error);
                    } else {
                        console.log('fewShotLoaded pool', message.pool);
                    }
                    break;
                case 'tableData':
                    if (message.table && message.rows) {
                        showTableData(message.table, message.rows);
                    } else {
                        const dbTableRows = document.getElementById('dbTableRows');
                        if (dbTableRows) {
                            dbTableRows.innerHTML = '<div class="results-error">Failed to load table data.</div>';
                        }
                    }
                    break;
            }
        }

        // 修复：更新Model选择器（处理空数据）
        function updateModelSelector(models) {
            const sel = document.getElementById('copilotModelSelect');
            sel.innerHTML = '';
            
            // 处理无模型的情况
            if (!models || models.length === 0) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = '⚠️ No Copilot models available';
                sel.appendChild(opt);
                sel.disabled = true;
                return;
            }
            
            // 正常加载模型列表
            sel.disabled = false;
            models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.name;
                // 默认选中第一个模型
                if (models.indexOf(m) === 0) {
                    opt.selected = true;
                }
                sel.appendChild(opt);
            });
        }

        // 初始化 Few-Shot 控制器
        function setupFewShotControls() {
            const historyInput = document.getElementById('historyShotsInput');
            const generalInput = document.getElementById('generalShotsInput');
            
            if (!historyInput || !generalInput) {
                console.warn('Few-shot input elements not found');
                return;
            }
            
            // 验证和约束输入值（0-10）
            function validateInput(input) {
                let val = parseInt(input.value || '0', 10);
                if (isNaN(val) || val < 0) val = 0;
                if (val > 10) val = 10;
                input.value = String(val);
                return val;
            }
            
            // 添加 change 事件处理器以验证范围
            historyInput.addEventListener('change', function() {
                validateInput(this);
                console.log('📊 History few-shots changed to:', this.value);
            });
            
            generalInput.addEventListener('change', function() {
                validateInput(this);
                console.log('📊 General few-shots changed to:', this.value);
            });
            
            // 添加 input 事件处理器以为输入提供实时反馈（可选）
            historyInput.addEventListener('input', function() {
                const val = parseInt(this.value || '0', 10);
                if (!isNaN(val) && val >= 0 && val <= 10) {
                    this.style.borderColor = '#4d4d4d';
                } else {
                    this.style.borderColor = '#ff6b6b';
                }
            });
            
            generalInput.addEventListener('input', function() {
                const val = parseInt(this.value || '0', 10);
                if (!isNaN(val) && val >= 0 && val <= 10) {
                    this.style.borderColor = '#4d4d4d';
                } else {
                    this.style.borderColor = '#ff6b6b';
                }
            });
            
            console.log('✅ Few-shot controls initialized');
        }

        // 数据库搜索逻辑
        function setupDatabaseSearch() {
            const searchInput = document.getElementById('dbSearchInput');
            const dropdown = document.getElementById('dbDropdown');
            
            searchInput.addEventListener('input', function() {
                const query = this.value.toLowerCase();
                filterDatabases(query);
                if (query && allDatabases.length > 0) {
                    dropdown.style.display = 'block';
                }
            });
            
            searchInput.addEventListener('focus', function() {
                if (allDatabases.length > 0) {
                    dropdown.style.display = 'block';
                    filterDatabases(this.value.toLowerCase());
                }
            });
            
            searchInput.addEventListener('blur', function() {
                setTimeout(() => {
                    dropdown.style.display = 'none';
                }, 150);
            });
        }

        // 过滤数据库列表
        function filterDatabases(query) {
            const dropdown = document.getElementById('dbDropdown');
            dropdown.innerHTML = '';
            
            if (!allDatabases || allDatabases.length === 0) {
                const option = document.createElement('div');
                option.className = 'database-option';
                option.textContent = 'No databases found';
                dropdown.appendChild(option);
                return;
            }
            
            const filteredDatabases = allDatabases.filter(db => 
                db.name.toLowerCase().includes(query)
            );
            
            if (filteredDatabases.length === 0) {
                const option = document.createElement('div');
                option.className = 'database-option';
                option.textContent = 'No matching databases';
                dropdown.appendChild(option);
                return;
            }
            
            filteredDatabases.forEach(db => {
                const option = document.createElement('div');
                option.className = 'database-option';
                option.textContent = db.name;
                if (selectedDatabase && selectedDatabase.name === db.name) {
                    option.classList.add('selected');
                }
                option.addEventListener('click', function() {
                    selectDatabase(db);
                });
                dropdown.appendChild(option);
            });
        }

        // 选择数据库
        function selectDatabase(db) {
            const searchInput = document.getElementById('dbSearchInput');
            const dropdown = document.getElementById('dbDropdown');
            
            searchInput.value = db.name;
            selectedDatabase = db;
            dropdown.style.display = 'none';

            // 切回主窗口模式
            if (dbDetailMode) {
                toggleDatabaseDetail();
            }
            
            const dbType = document.getElementById('dbTypeSelect').value;
            vscode.postMessage({
                command: 'getSchema',
                database: db.path || db.name,
                type: dbType
            });
        }

        // 更新字符计数
        function updateCharCount() {
            const input = document.getElementById('leftInput').value;
            document.getElementById('charCount').textContent = input.length + ' / 200';
        }

        // 数据库类型切换
        function onDatabaseTypeChange() {
            const dbType = document.getElementById('dbTypeSelect').value;
            const mysqlConfigBtn = document.getElementById('mysqlConfigBtn');
            
            if (dbType === 'mysql') {
                mysqlConfigBtn.style.display = 'inline-block';
            } else {
                mysqlConfigBtn.style.display = 'none';
            }
            
            document.getElementById('dbSearchInput').value = '';
            selectedDatabase = null;
            allDatabases = [];
            dbDetailMode = false;
            document.getElementById('dbDetailBtn').style.display = 'none';
            document.getElementById('dbDetailCard').style.display = 'none';
            document.querySelector('.model-card-container').style.display = 'block';
            document.getElementById('inputCard').style.display = 'block';
            
            refreshDatabases();
        }

        // 刷新数据库列表
        function refreshDatabases() {
            const dbType = document.getElementById('dbTypeSelect').value;
            const searchInput = document.getElementById('dbSearchInput');
            
            searchInput.placeholder = 'Loading...';
            allDatabases = [];
            selectedDatabase = null;
            
            vscode.postMessage({
                command: 'getDatabases',
                type: dbType
            });
        }

        // 配置MySQL
        function configureMySQL() {
            vscode.postMessage({ command: 'configureMySQL' });
        }

        // 上传数据库
        function uploadDatabase() {
            vscode.postMessage({ command: 'uploadDatabase' });
        }

        // 执行转换
        function performConvert() {
            const input = document.getElementById('leftInput').value;
            const dbType = document.getElementById('dbTypeSelect').value;
            
            if (!input.trim()) {
                document.getElementById('rightOutput').value = '-- Please enter natural language query first';
                return;
            }
            
            if (!selectedDatabase) {
                document.getElementById('rightOutput').value = '-- Please select a database first';
                return;
            }
            
            document.getElementById('rightOutput').value = '-- Converting... ⏳';
            
            const modelSel = document.getElementById('copilotModelSelect');
            const copilotModelId = modelSel ? modelSel.value : '';

            const historyInput = document.getElementById('historyShotsInput');
            const generalInput = document.getElementById('generalShotsInput');
            const rawHistoryCount = historyInput ? parseInt(historyInput.value || '1', 10) : 1;
            const rawGeneralCount = generalInput ? parseInt(generalInput.value || '3', 10) : 3;
            const historyFewShotCount = isNaN(rawHistoryCount) ? 1 : Math.max(0, Math.min(10, rawHistoryCount));
            const generalFewShotCount = isNaN(rawGeneralCount) ? 3 : Math.max(0, Math.min(10, rawGeneralCount));

            console.log('🎯 [WEBVIEW] convert with few-shot settings:', {
                historyFewShotCount,
                generalFewShotCount
            });

            vscode.postMessage({
                command: 'convert',
                text: input,
                database: dbType,
                selectedDb: selectedDatabase.path || selectedDatabase.name,
                schema: currentSchema,
                copilotModelId: copilotModelId,
                historyFewShotCount,
                generalFewShotCount
            });
        }

        function executeSqlFromOutput() {
            const sqlText = document.getElementById('rightOutput').value;
            const dbType = document.getElementById('dbTypeSelect').value;

            if (!sqlText.trim()) {
                document.getElementById('resultsOutput').innerHTML = '<div class="results-error">Please enter SQL to execute.</div>';
                return;
            }
            if (!selectedDatabase) {
                document.getElementById('resultsOutput').innerHTML = '<div class="results-error">Please select a database first.</div>';
                return;
            }

            document.getElementById('resultsOutput').innerHTML = '<div class="results-info">Executing SQL... ⏳</div>';

            vscode.postMessage({
                command: 'executeSQL',
                sql: sqlText,
                database: selectedDatabase.path || selectedDatabase.name,
                type: dbType
            });
        }

        function saveFewShot() {
            const nlq = document.getElementById('leftInput').value.trim();
            const sql = document.getElementById('rightOutput').value.trim();
            const dbId = selectedDatabase ? (selectedDatabase.path || selectedDatabase.name) : '';

            if (!dbId) {
                document.getElementById('resultsOutput').innerHTML = '<div class="results-error">Please select a database before saving few-shot.</div>';
                return;
            }
            if (!nlq) {
                document.getElementById('resultsOutput').innerHTML = '<div class="results-error">Please enter natural language query before saving few-shot.</div>';
                return;
            }
            if (!sql) {
                document.getElementById('resultsOutput').innerHTML = '<div class="results-error">Please generate or edit SQL before saving few-shot.</div>';
                return;
            }

            vscode.postMessage({
                command: 'saveFewShot',
                record: {
                    db_id: dbId,
                    nlq: nlq,
                    sql: sql
                }
            });
        }

        // 切换 Database Detail 模式
        function toggleDatabaseDetail() {
            if (!selectedDatabase || !currentSchema || currentSchema.length === 0) {
                return;
            }

            dbDetailMode = !dbDetailMode;
            const dbDetailBtn = document.getElementById('dbDetailBtn');
            const modelCard = document.querySelector('.model-card-container');
            const inputCard = document.getElementById('inputCard');
            const dbDetailCard = document.getElementById('dbDetailCard');

            if (dbDetailMode) {
                dbDetailBtn.textContent = '⬅️ Back to Input';
                modelCard.style.display = 'none';
                inputCard.style.display = 'none';
                dbDetailCard.style.display = 'flex';
                renderDatabaseDetail();
            } else {
                dbDetailBtn.textContent = '🗃️ Database Detail';
                modelCard.style.display = 'block';
                inputCard.style.display = 'block';
                dbDetailCard.style.display = 'none';
            }
        }

        function renderDatabaseDetail() {
            const dbTablesContainer = document.getElementById('dbTablesContainer');
            const dbTableDetails = document.getElementById('dbTableDetails');

            if (!currentSchema || currentSchema.length === 0) {
                dbTablesContainer.innerHTML = '<div class="results-info">No schema available.</div>';
                dbTableDetails.innerHTML = '';
                return;
            }

            dbTablesContainer.innerHTML = '';
            dbTableDetails.innerHTML = '<div class="results-info">Choose a table to view details</div>';

            // 列出表名
            currentSchema.forEach(table => {
                const tableItem = document.createElement('div');
                tableItem.className = 'db-detail-table-item' + (selectedDetailTable === table.name ? ' selected' : '');
                tableItem.textContent = table.name;
                tableItem.addEventListener('click', () => {
                    selectDetailTable(table.name);
                });
                dbTablesContainer.appendChild(tableItem);
            });
        }

        function selectDetailTable(tableName) {
            selectedDetailTable = tableName;
            const dbType = document.getElementById('dbTypeSelect').value;

            renderDatabaseDetail();

            const table = currentSchema.find(t => t.name === tableName);
            if (!table) {
                document.getElementById('dbTableDetails').innerHTML = '<div class="results-info">Table not found</div>';
                return;
            }

            // 显示列信息
            let html = '<div class="db-detail-columns">';
            table.columns.forEach(col => {
                let colInfo = escapeHtml(col.name) + ' (' + escapeHtml(col.type || 'text') + ')';
                if (col.pk) colInfo += ' PK';
                if (col.notnull) colInfo += ' NOT NULL';
                html += '<span>' + colInfo + '</span>';
            });
            html += '</div>';
            html += '<div id="dbTableRows" class="db-detail-rows">Loading rows...</div>';
            document.getElementById('dbTableDetails').innerHTML = html;

            // 直接请求样本数据（默认前100行，自动加载）
            loadTableData(tableName);
        }

        function loadTableData(tableName) {
            if (!selectedDatabase) {
                document.getElementById('dbTableDetails').innerHTML = '<div class="results-error">Select database first.</div>';
                return;
            }

            const dbTableRows = document.getElementById('dbTableRows');
            if (dbTableRows) {
                dbTableRows.innerHTML = '<div class="results-info">Loading table rows...</div>';
            }

            const dbType = document.getElementById('dbTypeSelect').value;
            vscode.postMessage({
                command: 'getTableData',
                table: tableName,
                database: selectedDatabase.path || selectedDatabase.name,
                type: dbType
            });
        }

        function showTableData(tableName, rows) {
            const dbTableRows = document.getElementById('dbTableRows');
            if (!dbTableRows) return;

            if (!rows || rows.length === 0) {
                dbTableRows.innerHTML = '<div class="results-info">No rows found.</div>';
                return;
            }

            const columns = Object.keys(rows[0]);
            let html = '<table class="results-table"><thead><tr>';
            columns.forEach(col => {
                html += '<th>' + escapeHtml(col) + '</th>';
            });
            html += '</tr></thead><tbody>';

            rows.forEach(row => {
                html += '<tr>';
                columns.forEach(col => {
                    html += '<td>' + escapeHtml(row[col] === null ? 'NULL' : String(row[col])) + '</td>';
                });
                html += '</tr>';
            });
            html += '</tbody></table>';
            dbTableRows.innerHTML = html;
        }

        // 清空输出
        function clearOutput() {
            const outputEl = document.getElementById('rightOutput');
            if (outputEl && outputEl.tagName === 'TEXTAREA') {
                outputEl.value = '';
            } else if (outputEl) {
                outputEl.textContent = '';
            }
            document.getElementById('resultsOutput').innerHTML = '<div class="results-info">-- Results cleared</div>';
        }

        // SQL语法高亮函数
        function highlightSQL(sql) {
            if (!sql) return '';
            
            // SQL关键字列表
            const keywords = [
                'SELECT', 'WHERE', 'FROM', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER',
                'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE',
                'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET',
                'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
                'CREATE', 'ALTER', 'DROP', 'TABLE', 'DATABASE', 'INDEX',
                'AS', 'DISTINCT', 'ALL', 'UNION', 'INTERSECT', 'EXCEPT',
                'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH', 'RECURSIVE',
                'CAST', 'COALESCE', 'NULLIF'
            ];
            
            let highlighted = sql;
            
            // 高亮关键字（词边界匹配，不区分大小写）
            keywords.forEach(keyword => {
                try {
                    const pattern = '\\\\b' + keyword + '\\\\b';
                    const regex = new RegExp(pattern, 'gi');
                    const replacement = '<span class="sql-keyword">' + keyword.toUpperCase() + '</span>';
                    highlighted = highlighted.replace(regex, replacement);
                } catch(e) {}
            });
            
            // 高亮字符串（单引号和双引号）
            highlighted = highlighted.replace(/'[^']*'/g, function(match) { 
                return '<span class="sql-string">' + match + '</span>'; 
            });
            highlighted = highlighted.replace(/"[^"]*"/g, function(match) { 
                return '<span class="sql-string">' + match + '</span>'; 
            });
            
            // 高亮数字
            highlighted = highlighted.replace(/\\d+/g, function(match) { 
                return '<span class="sql-number">' + match + '</span>'; 
            });
            
            return highlighted;
        }

        // 渲染结果表格
        function renderResultsTable(rows) {
            if (!rows || rows.length === 0) {
                document.getElementById('resultsOutput').innerHTML = 
                    '<div class="results-info">✅ Query executed. No data rows returned.</div>';
                return;
            }
            
            // 获取列名
            const columns = Object.keys(rows[0]);
            
            // 构建HTML表格
            let html = '<table class="results-table"><thead><tr>';
            columns.forEach(col => {
                html += '<th>' + escapeHtml(col) + '</th>';
            });
            html += '</tr></thead><tbody>';
            
            // 添加数据行
            rows.forEach(row => {
                html += '<tr>';
                columns.forEach(col => {
                    const value = row[col];
                    html += '<td>' + escapeHtml(value === null ? 'NULL' : String(value)) + '</td>';
                });
                html += '</tr>';
            });
            
            html += '</tbody></table>';
            document.getElementById('resultsOutput').innerHTML = html;
        }

        // HTML转义函数
        function escapeHtml(text) {
            const map = {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;'
            };
            return String(text).replace(/[&<>"']/g, m => map[m]);
        }

        // 更新数据库列表
        function updateDatabaseList(databases, error) {
            const searchInput = document.getElementById('dbSearchInput');
            
            allDatabases = databases || [];
            
            // 当已有选中数据库时，展示 Database Detail 按钮
            const detailBtn = document.getElementById('dbDetailBtn');
            if (selectedDatabase && currentSchema && currentSchema.length > 0) {
                detailBtn.style.display = 'inline-flex';
            } else {
                detailBtn.style.display = 'none';
            }
            
            if (error) {
                searchInput.placeholder = 'Error: ' + error;
                console.error('Database list error:', error);
                return;
            }
            
            if (!databases || databases.length === 0) {
                searchInput.placeholder = 'No databases found';
                return;
            }
            
            searchInput.placeholder = 'Search database... (' + databases.length + ' available)';
        }

        // 快捷键支持
        document.getElementById('leftInput').addEventListener('keydown', function(event) {
            if (event.key === 'Enter' && event.ctrlKey) {
                performConvert();
            }
        });
    </script>
</body>
</html>`;
    }
}

// Test DAIL-SQL API connection function
async function testDailSqlApiConnection(): Promise<void> {
    const config = vscode.workspace.getConfiguration('nl2sql');
    const apiUrl = config.get<string>('dailsql.apiUrl') || 'http://localhost:8000';
    
    try {
        vscode.window.showInformationMessage('🔍 Testing DAIL-SQL API connection...');
        
        // Test health endpoint
        console.log('Testing DAIL-SQL health endpoint...');
        const healthResponse = await axios.get(`${apiUrl}/api/v1/health`, { timeout: 10000 });
        console.log('Health check response:', healthResponse.data);
        
        // Test database list endpoint
        console.log('Testing DAIL-SQL database list endpoint...');
        const dbResponse = await axios.get(`${apiUrl}/api/v1/databases`, { timeout: 10000 });
        console.log('Database list response:', dbResponse.data);
        
        const availableDbs = dbResponse.data || [];
        const dbList = availableDbs.map((db: any) => ({
            id: db.database_id,
            tables: db.tables?.length || 0,
            description: db.description || 'No description'
        }));
        
        // Check for car_1 database specifically
        const car1Db = availableDbs.find((db: any) => db.database_id === 'car_1');
        
        // Test a simple query if car_1 is available
        let queryResult = null;
        if (car1Db) {
            console.log('Testing DAIL-SQL text-to-sql endpoint with car_1...');
            const testQuery = {
                question: "How many tables are in this database?",
                database_id: "car_1"
            };
            
            try {
                const queryResponse = await axios.post(`${apiUrl}/api/v1/text-to-sql`, testQuery, {
                    timeout: 300000,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    }
                });
                
                console.log('Test query response:', JSON.stringify(queryResponse.data, null, 2));
                queryResult = queryResponse.data;
            } catch (queryError) {
                console.error('Query test failed:', queryError);
                queryResult = { success: false, error: 'Query test failed' };
            }
        }
        
        // Create comprehensive status report
        const statusReport = [
            '🔗 DAIL-SQL API Connection Status',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            `📡 Server: ${apiUrl}`,
            `✅ Health Check: ${healthResponse.status === 200 ? 'OK' : 'FAILED'}`,
            `📊 Databases Available: ${availableDbs.length}`,
            ''
        ];
        
        if (availableDbs.length > 0) {
            statusReport.push('📋 Database List:');
            dbList.forEach((db: { id: string; tables: number; description: string }) => {
                statusReport.push(`  • ${db.id} (${db.tables} tables) - ${db.description}`);
            });
            statusReport.push('');
        } else {
            statusReport.push('⚠️ No databases found in server configuration!');
            statusReport.push('');
        }
        
        // Car_1 specific status
        if (car1Db) {
            statusReport.push('🚗 car_1 Database Status:');
            statusReport.push(`  • Found: YES`);
            statusReport.push(`  • Tables: ${car1Db.tables?.length || 0}`);
            statusReport.push(`  • Table Names: ${car1Db.tables?.join(', ') || 'Unknown'}`);
            
            if (queryResult) {
                statusReport.push(`  • Query Test: ${queryResult.success ? '✅ SUCCESS' : '❌ FAILED'}`);
                if (queryResult.success) {
                    statusReport.push(`  • Generated SQL: ${queryResult.best_sql || 'None'}`);
                    statusReport.push(`  • Processing Steps: ${queryResult.processing_steps?.length || 0}`);
                } else {
                    statusReport.push(`  • Error: ${queryResult.error || 'Unknown error'}`);
                    if (queryResult.processing_steps) {
                        statusReport.push(`  • Steps Completed: ${queryResult.processing_steps.length}`);
                        queryResult.processing_steps.forEach((step: string, i: number) => {
                            statusReport.push(`    ${i + 1}. ${step}`);
                        });
                    }
                }
            }
        } else {
            statusReport.push('🚗 car_1 Database Status:');
            statusReport.push('  • Found: ❌ NO');
            statusReport.push('  • Possible issues:');
            statusReport.push('    - Database not configured in DAIL-SQL server');
            statusReport.push('    - Incorrect database path in server config');
            statusReport.push('    - Database file permissions issue');
            statusReport.push('');
            statusReport.push('💡 To fix this:');
            statusReport.push('  1. Check DAIL-SQL server configuration');
            statusReport.push('  2. Verify database file exists at:');
            statusReport.push('     C:\\Users\\grizz\\OneDrive\\Desktop\\COSC448\\ideas\\model\\DAIL-SQL\\dataset\\spider\\database\\car_1\\car_1.sqlite');
            statusReport.push('  3. Ensure server has read permissions to the file');
            statusReport.push('  4. Restart DAIL-SQL server after configuration changes');
        }
        
        // Show comprehensive report
        vscode.window.showInformationMessage(
            statusReport.join('\\n'),
            { modal: true }
        );
        
    } catch (error) {
        console.error('DAIL-SQL API test failed:', error);
        
        let errorMsg = '❌ DAIL-SQL API Connection Failed\\n\\n';
        
        if (axios.isAxiosError(error)) {
            if (error.code === 'ECONNREFUSED') {
                errorMsg += `Cannot connect to DAIL-SQL server at ${apiUrl}\\n`;
                errorMsg += 'Please check if the DAIL-SQL server is running.\\n\\n';
                errorMsg += '💡 To start DAIL-SQL server:\\n';
                errorMsg += '  1. Navigate to your DAIL-SQL directory\\n';
                errorMsg += '  2. Run: python app.py (or similar)\\n';
                errorMsg += '  3. Check server logs for any errors';
            } else if (error.response) {
                errorMsg += `Server responded with ${error.response.status}: ${error.response.statusText}\\n`;
                errorMsg += `Response: ${JSON.stringify(error.response.data)}`;
            } else if (error.request) {
                errorMsg += `Network error: ${error.message}\\n`;
                errorMsg += 'Check your network connection and server URL.';
            } else {
                errorMsg += `Request error: ${error.message}`;
            }
        } else {
            errorMsg += `Unknown error: ${error}`;
        }
        
        vscode.window.showErrorMessage(errorMsg, { modal: true });
        throw error;
    }
}

// Helper function: Upload SQLite file to DAIL-SQL server programmatically
async function uploadSQLiteToDailSQL(filePath: string, databaseId: string): Promise<string> {
    try {
        const config = vscode.workspace.getConfiguration('nl2sql');
        const apiUrl = config.get<string>('dailsql.apiUrl') || 'http://localhost:8000';
        
        console.log(`📤 Checking/Uploading ${filePath} as ${databaseId} to DAIL-SQL server...`);
        
        // Check if DAIL-SQL service is available
        try {
            await axios.get(`${apiUrl}/api/v1/health`, { timeout: 5000 });
        } catch (error) {
            throw new Error('DAIL-SQL server is not available. Please start the server first.');
        }
        
        // Validate database ID
        if (!databaseId || !/^[a-zA-Z0-9_]+$/.test(databaseId)) {
            throw new Error('Invalid database ID. Must contain only letters, numbers, and underscores.');
        }
        
        // 方案1：使用现有数据库（推荐） - 首先检查数据库是否已经存在
        console.log(`  - Checking if database '${databaseId}' already exists...`);
        try {
            const dbListResponse = await axios.get(`${apiUrl}/api/v1/databases`, { timeout: 10000 });
            if (dbListResponse.data && Array.isArray(dbListResponse.data)) {
                const existingDb = dbListResponse.data.find((db: any) => db.database_id === databaseId);
                if (existingDb) {
                    const tables = existingDb.tables || [];
                    console.log(`✅ Database '${databaseId}' already exists with tables: ${tables.join(', ')}`);
                    console.log(`  - Reusing existing database instead of uploading new one`);
                    return databaseId;
                }
            }
            console.log(`  - Database '${databaseId}' not found, proceeding with upload...`);
        } catch (dbCheckError) {
            console.warn('❌ Failed to check existing databases, proceeding with upload:', dbCheckError);
            // Continue with upload even if database check fails
        }
        
        // Read file as buffer
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }
        
        const fileBuffer = fs.readFileSync(filePath);
        console.log(`  - File size: ${fileBuffer.length} bytes`);
        
        // Create form data for file upload
        const FormData = require('form-data');
        const formData = new FormData();
        formData.append('file', fileBuffer, {
            filename: path.basename(filePath),
            contentType: 'application/octet-stream'
        });
        formData.append('database_id', databaseId);
        
        // Upload to DAIL-SQL server
        console.log(`  - Sending request to ${apiUrl}/api/v1/upload-database`);
        const response = await axios.post(
            `${apiUrl}/api/v1/upload-database`,
            formData,
            {
                headers: {
                    ...formData.getHeaders(),
                    'Content-Length': formData.getLengthSync()
                },
                timeout: 60000, // 1 minute timeout for upload
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );
        
        console.log(`  - Server response:`, response.data);
        
        if (response.data?.success) {
            const tables = response.data.tables || [];
            console.log(`✅ Upload successful! Database ID: ${response.data.database_id}, Tables: ${tables.join(', ')}`);
            return response.data.database_id;
        } else {
            throw new Error(response.data?.message || 'Upload failed');
        }
    } catch (error) {
        console.error('❌ Upload failed:', error);
        if (axios.isAxiosError(error)) {
            if (error.response) {
                // 检查是否是数据库已存在的错误（作为备用方案）
                const errorMessage = JSON.stringify(error.response.data);
                if (errorMessage.includes('already exists') || errorMessage.includes('duplicate') || errorMessage.includes('Database ID already exists')) {
                    console.log(`⚠️ Database '${databaseId}' already exists, reusing existing database`);
                    return databaseId;
                }
                throw new Error(`Server error: ${error.response.status} - ${errorMessage}`);
            } else if (error.request) {
                throw new Error(`Network error: ${error.message}`);
            }
        }
        throw error;
    }
}

// Upload SQLite database to DAIL-SQL server
async function uploadSQLiteDatabase(): Promise<void> {
    try {
        // Get DAIL-SQL configuration
        const config = vscode.workspace.getConfiguration('nl2sql');
        const apiUrl = config.get<string>('dailsql.apiUrl') || 'http://localhost:8000';
        
        // Check if DAIL-SQL service is available
        try {
            await axios.get(`${apiUrl}/api/v1/health`, { timeout: 5000 });
        } catch (error) {
            throw new Error('DAIL-SQL server is not available. Please start the server first.');
        }
        
        // Show file picker for SQLite files
        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'SQLite Database': ['sqlite', 'sqlite3', 'db']
            },
            title: 'Select SQLite Database File'
        });
        
        if (!fileUri || fileUri.length === 0) {
            return; // User cancelled
        }
        
        const filePath = fileUri[0].fsPath;
        const fileName = path.basename(filePath, path.extname(filePath));
        
        // Ask user for database ID
        const databaseId = await vscode.window.showInputBox({
            prompt: 'Enter a unique database ID (letters, numbers, and underscores only)',
            value: fileName,
            validateInput: (value) => {
                if (!value || value.trim() === '') {
                    return 'Database ID cannot be empty';
                }
                if (!/^[a-zA-Z0-9_]+$/.test(value)) {
                    return 'Database ID can only contain letters, numbers, and underscores';
                }
                return undefined;
            }
        });
        
        if (!databaseId) {
            return; // User cancelled
        }
        
        // Show progress
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Uploading SQLite Database",
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: "Reading file..." });
            
            // Read file as buffer
            const fileBuffer = fs.readFileSync(filePath);
            
            progress.report({ increment: 30, message: "Preparing upload..." });
            
            // Create form data for file upload
            const FormData = require('form-data');
            const formData = new FormData();
            formData.append('file', fileBuffer, {
                filename: path.basename(filePath),
                contentType: 'application/octet-stream'
            });
            formData.append('database_id', databaseId);
            
            progress.report({ increment: 60, message: "Uploading to server..." });
            
            // Upload to DAIL-SQL server
            const response = await axios.post(
                `${apiUrl}/api/v1/upload-database`,
                formData,
                {
                    headers: {
                        ...formData.getHeaders(),
                        'Content-Length': formData.getLengthSync()
                    },
                    timeout: 60000, // 1 minute timeout for upload
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                }
            );
            
            progress.report({ increment: 100, message: "Upload complete!" });
            
            if (response.data?.success) {
                const tables = response.data.tables || [];
                vscode.window.showInformationMessage(
                    `✅ Database "${databaseId}" uploaded successfully!\\n` +
                    `📊 Found ${tables.length} tables: ${tables.join(', ')}`
                );
                
                // Refresh database list in panel if open
                if (NL2SQLPanel.currentPanel) {
                    NL2SQLPanel.currentPanel._panel.webview.postMessage({ 
                        command: 'refreshDatabases' 
                    });
                }
            } else {
                throw new Error(response.data?.message || 'Upload failed');
            }
        });
        
    } catch (error) {
        console.error('Database upload error:', error);
        
        let errorMsg = 'Failed to upload database: ';
        if (axios.isAxiosError(error)) {
            if (error.response?.data?.message) {
                errorMsg += error.response.data.message;
            } else if (error.code === 'ECONNREFUSED') {
                errorMsg += 'Cannot connect to DAIL-SQL server. Please check if the server is running.';
            } else {
                errorMsg += error.message;
            }
        } else {
            errorMsg += (error as Error).message;
        }
        
        vscode.window.showErrorMessage(errorMsg);
        throw error;
    }
}