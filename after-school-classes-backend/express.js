// server.js
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const port = 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Logger middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// MongoDB Connection URL - Should be in environment variables
const uri = process.env.MONGODB_URI || "mongodb+srv://naibiabdulhamid:naibi@cluster0.l9uodaf.mongodb.net/afterschool?retryWrites=true&w=majority";
let db;
let client;

// Improved MongoDB connection function with proper error handling
async function connect() {
    try {
        client = new MongoClient(uri, { 
            useNewUrlParser: true, 
            useUnifiedTopology: true 
        });
        await client.connect();
        db = client.db('afterschool');
        console.log('Connected to MongoDB Atlas');
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1); // Exit if we can't connect to database
    }
}

// Middleware to check if database is connected
const checkDB = (req, res, next) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not connected' });
    }
    next();
};

// Start server only after MongoDB connects
async function startServer() {
    await connect();
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}

startServer().catch(console.error);

// Helper function to validate ObjectId
const isValidObjectId = (id) => {
    try {
        return ObjectId.isValid(id) && (new ObjectId(id)).toString() === id;
    } catch (error) {
        return false;
    }
};

// Routes
// GET all lessons
app.get('/api/lessons', checkDB, async (req, res) => {
    try {
        const lessons = await db.collection('lessons').find({}).toArray();
        res.json(lessons);
    } catch (error) {
        console.error('Error fetching lessons:', error);
        res.status(500).json({ error: 'Error fetching lessons' });
    }
});

// Search lessons
app.get('/api/search', checkDB, async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) {
            return res.status(400).json({ error: 'Search query is required' });
        }

        const lessons = await db.collection('lessons').find({
            $or: [
                { subject: { $regex: query, $options: 'i' } },
                { location: { $regex: query, $options: 'i' } }
            ]
        }).toArray();
        res.json(lessons);
    } catch (error) {
        console.error('Error searching lessons:', error);
        res.status(500).json({ error: 'Error searching lessons' });
    }
});

// POST new order with transaction
app.post('/api/orders', checkDB, async (req, res) => {
    const session = client.startSession();
    try {
        await session.withTransaction(async () => {
            const { name, phone, lessons: lessonIds } = req.body;

            // Validate input
            if (!name || !phone || !lessonIds || !Array.isArray(lessonIds)) {
                throw new Error('Invalid input data');
            }

            // Validate lesson IDs
            if (!lessonIds.every(id => isValidObjectId(id))) {
                throw new Error('Invalid lesson ID format');
            }

            // Check if all lessons exist and have available spaces
            const lessons = await db.collection('lessons')
                .find({ _id: { $in: lessonIds.map(id => new ObjectId(id)) } })
                .toArray();

            if (lessons.length !== lessonIds.length) {
                throw new Error('One or more lessons not found');
            }

            if (lessons.some(lesson => lesson.spaces <= 0)) {
                throw new Error('One or more lessons are fully booked');
            }

            // Create order
            const order = {
                name,
                phone,
                lessonIds: lessonIds.map(id => new ObjectId(id)),
                orderDate: new Date()
            };

            await db.collection('orders').insertOne(order);

            // Update spaces for each lesson
            await Promise.all(lessonIds.map(lessonId =>
                db.collection('lessons').updateOne(
                    { _id: new ObjectId(lessonId) },
                    { $inc: { spaces: -1 } }
                )
            ));
        });

        res.json({ message: 'Order placed successfully' });
    } catch (error) {
        console.error('Error placing order:', error);
        res.status(400).json({ error: error.message || 'Error placing order' });
    } finally {
        await session.endSession();
    }
});

// PUT update lesson spaces
app.put('/api/lessons/:id', checkDB, async (req, res) => {
    const { id } = req.params;
    const { spaces } = req.body;
    if (!isValidObjectId(id)) {
        return res.status(400).json({ error: 'Invalid lesson ID format' });
    }
    if (typeof spaces !== 'number' || spaces < 0) {
        return res.status(400).json({ error: 'Invalid spaces value' });
    }
    const result = await db.collection('lessons').updateOne(
        { _id: new ObjectId(id) },
        { $set: { spaces } }
    );
    res.json(result.matchedCount > 0 ? { message: 'Lesson updated' } : { error: 'Lesson not found' });
});


// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Received SIGTERM. Performing graceful shutdown...');
    if (client) {
        await client.close();
    }
    process.exit(0);
});