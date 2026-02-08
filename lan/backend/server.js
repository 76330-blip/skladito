const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://warehouse-db:27017/warehouse';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

let db;

// Генерация токена
function generateToken() {
    return crypto.randomBytes(24).toString('hex');
}

// Middleware: получить текущего пользователя по заголовку X-User-Id
async function authMiddleware(req, res, next) {
    const userId = req.headers['x-user-id'];
    if (!userId) {
        return res.status(401).json({ error: 'Не авторизован' });
    }
    const user = await db.collection('users').findOne({ id: userId, isActive: true });
    if (!user) {
        return res.status(401).json({ error: 'Пользователь не найден или не активирован' });
    }
    req.user = user;
    next();
}

// Middleware: только админ
function adminOnly(req, res, next) {
    if (!req.user || !req.user.isAdmin) {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }
    next();
}

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

        // Инициализация админа по умолчанию
        const usersCount = await db.collection('users').countDocuments();
        if (usersCount === 0) {
            await db.collection('users').insertOne({
                id: 'u_admin',
                name: 'Админ',
                code: '0000',
                isAdmin: true,
                isActive: true,
                inviteToken: null,
                inviteExpires: null
            });
            console.log('✅ Default admin created (code: 0000)');
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

// === АВТОРИЗАЦИЯ ===

// POST /api/auth/login
app.post('/auth/login', async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'Введите код' });
        const user = await db.collection('users').findOne({ code, isActive: true });
        if (!user) return res.status(401).json({ error: 'Неверный код' });
        const { code: _, ...safeUser } = user;
        delete safeUser._id;
        res.json({ user: safeUser });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/auth/activate
app.post('/auth/activate', async (req, res) => {
    try {
        const { inviteToken, code } = req.body;
        if (!inviteToken || !code) return res.status(400).json({ error: 'Заполните все поля' });
        if (code.length < 4 || code.length > 6 || !/^\d+$/.test(code)) {
            return res.status(400).json({ error: 'Код должен быть от 4 до 6 цифр' });
        }
        // Проверить уникальность кода
        const existingCode = await db.collection('users').findOne({ code, isActive: true });
        if (existingCode) return res.status(400).json({ error: 'Этот код уже занят, выберите другой' });

        const user = await db.collection('users').findOne({ inviteToken, isActive: false });
        if (!user) return res.status(404).json({ error: 'Приглашение не найдено или уже использовано' });
        if (user.inviteExpires && new Date(user.inviteExpires) < new Date()) {
            return res.status(400).json({ error: 'Приглашение истекло' });
        }
        await db.collection('users').updateOne({ id: user.id }, {
            $set: { code, isActive: true, inviteToken: null, inviteExpires: null }
        });
        const updated = await db.collection('users').findOne({ id: user.id });
        const { code: _, ...safeUser } = updated;
        delete safeUser._id;
        res.json({ user: safeUser });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/auth/invite/:token — получить данные приглашения
app.get('/auth/invite/:token', async (req, res) => {
    try {
        const user = await db.collection('users').findOne({ inviteToken: req.params.token, isActive: false });
        if (!user) return res.status(404).json({ error: 'Приглашение не найдено' });
        if (user.inviteExpires && new Date(user.inviteExpires) < new Date()) {
            return res.status(400).json({ error: 'Приглашение истекло' });
        }
        res.json({ name: user.name, id: user.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// === ПОЛЬЗОВАТЕЛИ (только админ) ===

// GET /api/users
app.get('/users', authMiddleware, adminOnly, async (req, res) => {
    try {
        const users = await db.collection('users').find().toArray();
        const safe = users.map(u => {
            const { code, _id, ...rest } = u;
            return rest;
        });
        res.json(safe);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/users
app.post('/users', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { name, isAdmin } = req.body;
        if (!name) return res.status(400).json({ error: 'Укажите имя' });
        const inviteToken = generateToken();
        const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const user = {
            id: 'u' + Date.now(),
            name,
            code: null,
            isAdmin: isAdmin || false,
            isActive: false,
            inviteToken,
            inviteExpires
        };
        await db.collection('users').insertOne(user);
        const { code, _id, ...safeUser } = user;
        res.status(201).json({ user: safeUser, inviteToken });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/users/:id
app.delete('/users/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { id } = req.params;
        if (id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить самого себя' });
        await db.collection('users').deleteOne({ id });
        await db.collection('containerAccess').deleteMany({ userId: id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/users/:id/reset
app.post('/users/:id/reset', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { id } = req.params;
        const inviteToken = generateToken();
        const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await db.collection('users').updateOne({ id }, {
            $set: { code: null, isActive: false, inviteToken, inviteExpires }
        });
        res.json({ inviteToken });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДОСТУПА ===

// Получить все контейнеры, к которым пользователь имеет доступ
async function getAccessibleContainerIds(userId) {
    // Получить все контейнеры
    const allContainers = await db.collection('containers').find().toArray();
    // Контейнеры, где пользователь — владелец
    const ownedIds = new Set(allContainers.filter(c => c.ownerId === userId).map(c => c.id));
    // Контейнеры, к которым есть прямой доступ (помощник)
    const accessRecords = await db.collection('containerAccess').find({ userId }).toArray();
    const directAccessIds = new Set(accessRecords.map(a => a.containerId));

    // Корневые контейнеры, к которым есть доступ
    const rootAccessIds = new Set([...ownedIds, ...directAccessIds]);

    // Добавить все вложенные контейнеры
    const allAccessible = new Set(rootAccessIds);
    function addChildren(parentId) {
        allContainers.filter(c => c.parent === parentId).forEach(child => {
            allAccessible.add(child.id);
            addChildren(child.id);
        });
    }
    rootAccessIds.forEach(id => addChildren(id));
    return allAccessible;
}

// === КОНТЕЙНЕРЫ ===

// Синхронизация — получить все данные (с учётом прав)
app.get('/sync', authMiddleware, async (req, res) => {
    try {
        const user = req.user;
        let containers, items;
        if (user.isAdmin) {
            containers = await db.collection('containers').find().toArray();
            items = await db.collection('items').find().toArray();
        } else {
            const accessibleIds = await getAccessibleContainerIds(user.id);
            containers = await db.collection('containers').find().toArray();
            containers = containers.filter(c => accessibleIds.has(c.id));
            items = await db.collection('items').find().toArray();
            const idsSet = new Set(containers.map(c => c.id));
            items = items.filter(i => idsSet.has(i.container));
        }
        const categories = await db.collection('categories').find().sort({ order: 1 }).toArray();
        res.json({ containers, items, categories });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/containers', authMiddleware, async (req, res) => {
    try {
        const user = req.user;
        let containers;
        if (user.isAdmin) {
            containers = await db.collection('containers').find().toArray();
        } else {
            const accessibleIds = await getAccessibleContainerIds(user.id);
            containers = await db.collection('containers').find().toArray();
            containers = containers.filter(c => accessibleIds.has(c.id));
        }
        res.json(containers);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/containers', authMiddleware, async (req, res) => {
    try {
        let ownerId = req.user.id;
        if (req.body.parent) {
            const parentContainer = await db.collection('containers').findOne({ id: req.body.parent });
            if (parentContainer) {
                ownerId = parentContainer.ownerId || req.user.id;
            }
        }
        const container = {
            id: 'c' + Date.now(),
            name: req.body.name,
            number: req.body.number || null,
            photo: req.body.photo || null,
            parent: req.body.parent || null,
            ownerId: ownerId,
            created: new Date().toISOString()
        };
        await db.collection('containers').insertOne(container);
        res.status(201).json(container);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/containers/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const update = {};
        if (req.body.name !== undefined) update.name = req.body.name;
        if (req.body.number !== undefined) update.number = req.body.number;
        if (req.body.photo !== undefined) update.photo = req.body.photo;
        if (req.body.parent !== undefined) update.parent = req.body.parent;

        await db.collection('containers').updateOne({ id }, { $set: update });
        const container = await db.collection('containers').findOne({ id });
        res.json(container);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/containers/:id', authMiddleware, async (req, res) => {
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
        await db.collection('containerAccess').deleteMany({ containerId: id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// === ПРЕДМЕТЫ ===

app.get('/items', authMiddleware, async (req, res) => {
    try {
        const items = await db.collection('items').find().toArray();
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/items', authMiddleware, async (req, res) => {
    try {
        const item = {
            id: 'i' + Date.now(),
            name: req.body.name,
            quantity: req.body.quantity || 1,
            minQuantity: req.body.minQuantity || 0,
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

app.put('/items/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const update = {};
        if (req.body.name !== undefined) update.name = req.body.name;
        if (req.body.quantity !== undefined) update.quantity = req.body.quantity;
        if (req.body.minQuantity !== undefined) update.minQuantity = req.body.minQuantity;
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

app.delete('/items/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        await db.collection('items').deleteOne({ id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// === КАТЕГОРИИ ===

app.get('/categories', authMiddleware, async (req, res) => {
    try {
        const categories = await db.collection('categories').find().sort({ order: 1 }).toArray();
        res.json(categories);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/categories', authMiddleware, async (req, res) => {
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

app.put('/categories/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const update = {};
        if (req.body.name !== undefined) update.name = req.body.name;
        if (req.body.icon !== undefined) update.icon = req.body.icon;
        await db.collection('categories').updateOne({ id }, { $set: update });
        const cat = await db.collection('categories').findOne({ id });
        res.json(cat);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/categories/:id', authMiddleware, async (req, res) => {
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

// === ДОСТУП К КОНТЕЙНЕРАМ ===

// POST /api/container-access — дать доступ
app.post('/container-access', authMiddleware, async (req, res) => {
    try {
        const { containerId, userId } = req.body;
        if (!containerId || !userId) return res.status(400).json({ error: 'containerId и userId обязательны' });
        const container = await db.collection('containers').findOne({ id: containerId });
        if (!container) return res.status(404).json({ error: 'Контейнер не найден' });
        if (container.ownerId !== req.user.id && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Только владелец может управлять доступом' });
        }
        // Проверить, нет ли уже доступа
        const existing = await db.collection('containerAccess').findOne({ containerId, userId });
        if (existing) return res.status(400).json({ error: 'Доступ уже есть' });
        await db.collection('containerAccess').insertOne({ containerId, userId });
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/container-access — забрать доступ
app.delete('/container-access', authMiddleware, async (req, res) => {
    try {
        const { containerId, userId } = req.body;
        if (!containerId || !userId) return res.status(400).json({ error: 'containerId и userId обязательны' });
        const container = await db.collection('containers').findOne({ id: containerId });
        if (!container) return res.status(404).json({ error: 'Контейнер не найден' });
        if (container.ownerId !== req.user.id && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Только владелец может управлять доступом' });
        }
        await db.collection('containerAccess').deleteOne({ containerId, userId });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/container-access/:containerId — получить список помощников
app.get('/container-access/:containerId', authMiddleware, async (req, res) => {
    try {
        const records = await db.collection('containerAccess').find({ containerId: req.params.containerId }).toArray();
        res.json(records);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// === ПОИСК ===

app.get('/search', authMiddleware, async (req, res) => {
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
