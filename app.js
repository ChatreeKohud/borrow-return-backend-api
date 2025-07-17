// app.js

const express = require('express');
const { Pool } = require('pg'); // Import Pool object จาก node-postgres
const app = express();
const port = process.env.PORT || 3000; // กำหนด Port สำหรับ Server, ใช้ env.PORT ถ้ามี (สำหรับ Cloud)

// Middleware สำหรับการอ่าน JSON request body
app.use(express.json());

// ----------------------------------------------------------------------
// การตั้งค่าการเชื่อมต่อ PostgreSQL (ดึงมาจาก Neon.tech Connection String)
// ----------------------------------------------------------------------
const connectionString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_xO84lzRQrDXa@ep-square-bird-a1jitohv-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const pool = new Pool({
    connectionString: connectionString,
    ssl: {
        // สำหรับ Neon.tech ส่วนใหญ่จะใช้ require โดยไม่จำเป็นต้องระบุ CA
        // แต่ถ้า deploy บนบางแพลตฟอร์ม อาจจะต้องตั้งค่าเพิ่มเติม
        // rejectUnauthorized: false // อาจจะต้องเปิดถ้ามีปัญหา SSL certificates
    }
});

// ทดสอบการเชื่อมต่อ Database
pool.connect()
    .then(client => {
        console.log('Connected to PostgreSQL database successfully!');
        client.release(); // คืน client กลับสู่ pool
    })
    .catch(err => {
        console.error('Error connecting to PostgreSQL database:', err.message);
        console.error('Connection String:', connectionString);
        process.exit(1); // ออกจากโปรแกรมหากเชื่อมต่อ DB ไม่ได้
    });

// ----------------------------------------------------------------------
// Routes (API Endpoints) สำหรับระบบเบิก-คืนของ
// ----------------------------------------------------------------------

// API สำหรับดูรายการสินค้าทั้งหมด
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY product_name');
        res.json(result.rows); // ส่งข้อมูลสินค้ากลับไปเป็น JSON
    } catch (err) {
        console.error('Error fetching products:', err.message);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

// API สำหรับเบิกสินค้า
// รับ JSON body: { "productId": 1, "userId": 1, "quantity": 2 }
app.post('/api/borrow', async (req, res) => {
    const { productId, userId, quantity } = req.body;

    if (!productId || !userId || !quantity || quantity <= 0) {
        return res.status(400).json({ error: 'Invalid request data' });
    }

    const client = await pool.connect(); // ได้ client จาก pool
    try {
        await client.query('BEGIN'); // เริ่มต้น Transaction

        // 1. ตรวจสอบสต็อก
        const productResult = await client.query('SELECT current_stock FROM products WHERE product_id = $1 FOR UPDATE', [productId]);
        if (productResult.rows.length === 0) {
            await client.query('ROLLBACK'); // Rollback Transaction
            return res.status(404).json({ error: 'Product not found' });
        }
        const currentStock = productResult.rows[0].current_stock;
        if (currentStock < quantity) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Not enough stock available' });
        }

        // 2. อัปเดตสต็อก
        await client.query('UPDATE products SET current_stock = current_stock - $1 WHERE product_id = $2', [quantity, productId]);

        // 3. บันทึกรายการเบิก
        const borrowRecord = await client.query(
            'INSERT INTO borrowing_records (product_id, user_id, quantity_borrowed) VALUES ($1, $2, $3) RETURNING *',
            [productId, userId, quantity]
        );

        await client.query('COMMIT'); // Commit Transaction
        res.status(201).json({ message: 'Item borrowed successfully', record: borrowRecord.rows[0] });

    } catch (err) {
        await client.query('ROLLBACK'); // Rollback ถ้ามี error
        console.error('Error borrowing item:', err.message);
        res.status(500).json({ error: 'Failed to borrow item', details: err.message });
    } finally {
        client.release(); // คืน client กลับ pool เสมอ
    }
});

// API สำหรับคืนสินค้า
// รับ JSON body: { "borrowId": 1, "quantityReturned": 1 }
app.post('/api/return', async (req, res) => {
    const { borrowId, quantityReturned } = req.body;

    if (!borrowId || !quantityReturned || quantityReturned <= 0) {
        return res.status(400).json({ error: 'Invalid request data' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. ดึงข้อมูลการเบิก
        const borrowRecordResult = await client.query('SELECT * FROM borrowing_records WHERE borrow_id = $1 FOR UPDATE', [borrowId]);
        if (borrowRecordResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Borrow record not found' });
        }
        const borrowRecord = borrowRecordResult.rows[0];

        // ตรวจสอบว่าจำนวนที่คืนไม่เกินจำนวนที่เบิกและยังไม่ถูกคืนหมด
        if (borrowRecord.status === 'returned') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'This item has already been fully returned.' });
        }
        // ในระบบจริง ควรมี field tracking_returned_qty ใน borrowing_records เพื่อเก็บว่าคืนไปแล้วเท่าไหร่
        // แต่สำหรับตัวอย่างนี้ เราจะอ้างอิงจาก quantity_borrowed เท่านั้น
        if (quantityReturned > borrowRecord.quantity_borrowed) {
             await client.query('ROLLBACK');
             return res.status(400).json({ error: 'Quantity returned exceeds quantity borrowed.' });
        }


        // 2. อัปเดตสต็อกสินค้า (เพิ่มคืน)
        await client.query('UPDATE products SET current_stock = current_stock + $1 WHERE product_id = $2', [quantityReturned, borrowRecord.product_id]);

        // 3. บันทึกรายการคืน
        await client.query(
            'INSERT INTO returning_records (borrow_id, quantity_returned, returned_by_user_id) VALUES ($1, $2, $3)',
            [borrowId, quantityReturned, borrowRecord.user_id] // สมมติว่าคนคืนเป็นคนเดียวกับคนเบิก
        );

        // 4. อัปเดตสถานะการเบิก (ถ้าคืนครบ)
        // Note: ในระบบจริง ควรมี logic ที่ซับซ้อนกว่านี้ เช่น เก็บว่าคืนไปแล้วเท่าไหร่
        if (quantityReturned === borrowRecord.quantity_borrowed) {
             await client.query('UPDATE borrowing_records SET status = \'returned\' WHERE borrow_id = $1', [borrowId]);
        }


        await client.query('COMMIT');
        res.status(200).json({ message: 'Item returned successfully' });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error returning item:', err.message);
        res.status(500).json({ error: 'Failed to return item', details: err.message });
    } finally {
        client.release();
    }
});


// ----------------------------------------------------------------------
// เริ่ม Server
// ----------------------------------------------------------------------
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Access API at http://localhost:${port}/api/products`);
});