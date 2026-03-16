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
    'student_shares': {
        sqliteColumns: ['school', 'major', 'grade', 'title', 'content', 'tags', 'images', 'status', 'upload_time', 'usefulness_ratio', 'author_nickname', 'analyzed_at', 'delete_after', 'is_emotional'],
        mysqlColumns: ['school', 'major', 'grade', 'title', 'content', 'tags', 'images', 'status', 'upload_time', 'usefulness_ratio', 'author_nickname', 'analyzed_at', 'delete_after', 'is_emotional']
    },
    'verified_users': {
        sqliteColumns: ['email', 'school_name', 'auth_type', 'auth_token', 'token_expires_at', 'verified_at', 'nickname'],
        mysqlColumns: ['email', 'school_name', 'auth_type', 'auth_token', 'token_expires_at', 'verified_at', 'nickname']
    },
    'schools': {
        sqliteColumns: ['school_name', 'school_level', 'location', 'description'],
        mysqlColumns: ['school_name', 'school_level', 'location', 'description']
    },
    'major_overviews': {
        sqliteColumns: ['major_code', 'major_name', 'category', 'degree_type', 'duration', 'description', 'core_courses', 'career_prospects', 'related_majors', 'training_plan', 'admission_plan'],
        mysqlColumns: ['major_code', 'major_name', 'category', 'degree_type', 'duration', 'description', 'core_courses', 'career_prospects', 'related_majors', 'training_plan', 'admission_plan']
    },
    'school_programs': {
        sqliteColumns: ['major_id', 'school_name', 'school_level', 'location', 'program_features', 'courses', 'course_intros', 'admission_requirements', 'tuition_fee', 'scholarships', 'contact_info'],
        mysqlColumns: ['major_id', 'school_name', 'school_level', 'location', 'program_features', 'courses', 'course_intros', 'admission_requirements', 'tuition_fee', 'scholarships', 'contact_info']
    },
    'major_news': {
        sqliteColumns: ['major_id', 'title', 'content', 'source', 'publish_date', 'is_hot'],
        mysqlColumns: ['major_id', 'title', 'content', 'source', 'publish_date', 'is_hot']
    }
};

async function migrate() {
    console.log('🚀 开始从 SQLite 迁移数据到 MySQL...');
    console.log('📂 SQLite 路径:', CONFIG.sqlitePath);
    let mysqlConn;
    try {
        mysqlConn = await mysql.createConnection(CONFIG.mysql);
        console.log('✅ MySQL 连接成功');
        const sqliteDb = new sqlite3.Database(CONFIG.sqlitePath, sqlite3.OPEN_READONLY);
        
        for (const [tableName, config] of Object.entries(TABLES_TO_MIGRATE)) {
            const { sqliteColumns, mysqlColumns } = config;
            console.log(`\n📋 正在处理表: ${tableName}`);
            const rows = await new Promise((resolve, reject) => {
                sqliteDb.all(`SELECT * FROM ${tableName}`, [], (err, rows) => {
                    if (err) {
                        console.error(`❌ 读取表 ${tableName} 失败:`, err.message);
                        resolve([]);
                    }
                    else resolve(rows);
                });
            });

            console.log(`   查询到 ${rows.length} 条数据`);
            if (rows.length === 0) continue;

            const placeholders = mysqlColumns.map(() => '?').join(', ');
            const insertSql = `INSERT INTO ${tableName} (${mysqlColumns.join(', ')}) VALUES (${placeholders})`;

            let count = 0;
            let failed = 0;
            for (const row of rows) {
                try {
                    const values = sqliteColumns.map(col => {
                        let val = row[col];
                        // 转换 ISO 8601 时间格式
                        if (val && typeof val === 'string' && val.includes('T') && val.endsWith('Z')) {
                            val = val.replace('T', ' ').replace('Z', '').slice(0, 19);
                        }
                        return val === undefined ? null : val;
                    });
                    await mysqlConn.execute(insertSql, values);
                    count++;
                } catch (e) {
                    failed++;
                    if (failed <= 3) console.error(`   ⚠️ 插入失败:`, e.message);
                }
            }
            if (failed > 3) console.error(`   ⚠️ 还有 ${failed - 3} 条失败...`);
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
