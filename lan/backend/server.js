const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');

const app = express();
const PORT = 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://warehouse-db:27017/warehouse';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

let db;

// Подключение к MongoDB
async function connectDB() {
    try {
        const client = await MongoClient.connect(MONGO_URI);
        db = client.db('warehouse');
        console.log('✅ Connected to MongoDB');
        
        // Инициализация категорий по умолчанию
        const categories = await db.collection('categories').find().toArray();
        if (categories.length === 0) {
            await db.collection('categories').insertMany([
                { id: 'cat1', name: 'Инструменты', icon: '🔧', order: 1 },
                { id: 'cat2', name: 'Канцелярия', icon: '📝', order: 2 },
                { id: 'cat3', name: 'Бытовые вещи', icon: '🏠', order: 3 },
                { id: 'cat4', name: 'Электроника', icon: '⚡', order: 4 },
                { id: 'cat5', name: 'Одежда', icon: '👕', order: 5 }
            ]);
            console.log('✅ Default categories created');
        }
    } catch (err) {
        console.error('❌ MongoDB connection error:', err);
        process.exit(1);
    }
}

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '2.0' });
});

// Синхронизация - получить все данные
app.get('/sync', async (req, res) => {
    try {
        const containers = await db.collection('containers').find().toArray();
        const items = await db.collection('items').find().toArray();
        const categories = await db.collection('categories').find().sort({ order: 1 }).toArray();
        res.json({ containers, items, categories });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// === КОНТЕЙНЕРЫ ===

app.get('/containers', async (req, res) => {
    try {
        const containers = await db.collection('containers').find().toArray();
        res.json(containers);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/containers', async (req, res) => {
    try {
        const container = {
            id: 'c' + Date.now(),
            name: req.body.name,
            photo: req.body.photo || null,
            parent: req.body.parent || null,
            created: new Date().toISOString()
        };
        await db.collection('containers').insertOne(container);
        res.status(201).json(container);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/containers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const update = {};
        if (req.body.name !== undefined) update.name = req.body.name;
        if (req.body.photo !== undefined) update.photo = req.body.photo;
        if (req.body.parent !== undefined) update.parent = req.body.parent;
        
        await db.collection('containers').updateOne({ id }, { $set: update });
        const container = await db.collection('containers').findOne({ id });
        res.json(container);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/containers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Проверка на вложенные контейнеры
        const children = await db.collection('containers').countDocuments({ parent: id });
        if (children > 0) {
            return res.status(400).json({ error: 'Container has nested containers' });
        }
        
        // Проверка на предметы
        const items = await db.collection('items').countDocuments({ container: id });
        if (items > 0) {
            return res.status(400).json({ error: 'Container has items' });
        }
        
        await db.collection('containers').deleteOne({ id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// === ПРЕДМЕТЫ ===

app.get('/items', async (req, res) => {
    try {
        const items = await db.collection('items').find().toArray();
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/items', async (req, res) => {
    try {
        const item = {
            id: 'i' + Date.now(),
            name: req.body.name,
            quantity: req.body.quantity || 1,
            category: req.body.category || null,
            photo: req.body.photo || null,
            container: req.body.container,
            created: new Date().toISOString()
        };
        await db.collection('items').insertOne(item);
        res.status(201).json(item);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/items/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const update = {};
        if (req.body.name !== undefined) update.name = req.body.name;
        if (req.body.quantity !== undefined) update.quantity = req.body.quantity;
        if (req.body.category !== undefined) update.category = req.body.category;
        if (req.body.photo !== undefined) update.photo = req.body.photo;
        if (req.body.container !== undefined) update.container = req.body.container;
        
        await db.collection('items').updateOne({ id }, { $set: update });
        const item = await db.collection('items').findOne({ id });
        res.json(item);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/items/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.collection('items').deleteOne({ id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// === КАТЕГОРИИ ===

app.get('/categories', async (req, res) => {
    try {
        const categories = await db.collection('categories').find().sort({ order: 1 }).toArray();
        res.json(categories);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/categories', async (req, res) => {
    try {
        const maxOrder = await db.collection('categories').find().sort({ order: -1 }).limit(1).toArray();
        const order = maxOrder.length > 0 ? maxOrder[0].order + 1 : 1;
        
        const category = {
            id: 'cat' + Date.now(),
            name: req.body.name,
            icon: req.body.icon || '📁',
            order: order
        };
        await db.collection('categories').insertOne(category);
        res.status(201).json(category);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/categories/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Убрать категорию у всех предметов
        await db.collection('items').updateMany({ category: id }, { $set: { category: null } });
        
        await db.collection('categories').deleteOne({ id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// === ПОИСК ===

app.get('/search', async (req, res) => {
    try {
        const q = req.query.q || '';
        const regex = new RegExp(q, 'i');
        
        const containers = await db.collection('containers').find({ name: regex }).toArray();
        const items = await db.collection('items').find({ name: regex }).toArray();
        
        res.json({ containers, items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Запуск сервера
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 SKLADITO API running on port ${PORT}`);
    });
});
