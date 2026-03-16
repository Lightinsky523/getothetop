const sqlite3 = require('sqlite3').verbose();
const mysql = require('mysql2/promise');
const path = require('path');

const CONFIG = {
    sqlitePath: path.join(__dirname, 'data', 'study_experience.db'),
    mysql: {
        host: '172.17.0.1',
        user: 'root',
        password: '@Ycyz120',
        database: 'ycyz_db',
        port: 3306
    }
};

const TABLES_TO_MIGRATE = {
    'student_shares': ['school', 'major', 'city', 'gaokao_year', 'experience', 'label', 'author', 'create_at', 'likes', 'dislikes'],
    'verified_users': ['email', 'nickname', 'auth_type', 'verified_at'],
    'schools': ['name', 'city', 'tags', 'intro'],
    'majors': ['name', 'category'],
    'school_programs': ['school_id', 'major_id', 'course_intros'],
    'major_overviews': ['major_name', 'intro', 'employment', 'salary_level', 'admission_plan'],
    'major_news': ['major_id', 'title', 'content', 'publish_date', 'source_url', 'is_hot']
};

async function migrate() {
    console.log('🚀 开始从 SQLite 迁移数据到 MySQL...');
    let mysqlConn;
    try {
        mysqlConn = await mysql.createConnection(CONFIG.mysql);
        console.log('✅ MySQL 连接成功');
        const sqliteDb = new sqlite3.Database(CONFIG.sqlitePath, sqlite3.OPEN_READONLY);
        
        for (const [tableName, columns] of Object.entries(TABLES_TO_MIGRATE)) {
            const rows = await new Promise((resolve) => {
                sqliteDb.all(`SELECT * FROM ${tableName}`, [], (err, rows) => {
                    if (err) resolve([]);
                    else resolve(rows);
                });
            });

            if (rows.length === 0) continue;
            const placeholders = columns.map(() => '?').join(', ');
            const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;

            let count = 0;
            for (const row of rows) {
                try {
                    const values = columns.map(col => row[col] === undefined ? null : row[col]);
                    await mysqlConn.execute(insertSql, values);
                    count++;
                } catch (e) { /* 忽略重复项 */ }
            }
            console.log(`✅ 表 ${tableName}: 成功迁移 ${count} 条数据`);
        }
        console.log('\n✨ 所有任务已完成！');
    } catch (err) {
        console.error('❌ 错误:', err.message);
    } finally {
        if (mysqlConn) await mysqlConn.end();
        process.exit(0);
    }
}
migrate();
