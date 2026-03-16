const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

// OpenAI для генерации AI анализа
const { OpenAI } = require('openai');
const openai = new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY || 'sk-abcdef1234567890abcdef1234567890abcdef12'
});

const Genres = require('../Genres/Genres');
const User = require('../auth/User');
const Blog = require('../Blogs/blog');
const Comment = require("../Comments/Comments");
const Analysis = require('../Analysis/Analysis');

// Функция для генерации AI анализа
async function generateAISummary(parsedResults) {
    const prompt = `
    Ты — профессиональный медицинский ИИ-ассистент. Проанализируй эти результаты анализов крови:
    ${JSON.stringify(parsedResults)}
    
    Верни ответ СТРОГО в формате JSON. Текст внутри JSON должен быть на английском (чтобы соответствовать дизайну интерфейса), но адаптирован под пациента. 
    
    Используй строго эту структуру:
    {
      "summary": "Short 1-2 sentence overall summary of the health status.",
      "keyFindings": [
        {
          "name": "Marker Name (e.g. Hemoglobin)",
          "value": "Value + Unit",
          "range": "Normal range (e.g. 13.5-17.5 g/dL)",
          "status": "NORMAL or BORDERLINE or HIGH or LOW",
          "comment": "Short comment (max 5 words)"
        }
      ],
      "recommendations": ["Recommendation 1", "Recommendation 2", "Recommendation 3"],
      "riskFactors": ["Risk factor 1 if any, otherwise leave empty array"],
      "nextSteps": "One paragraph of next steps."
    }
    Выбери только 3-4 самых важных показателя для массива keyFindings (включая те, что выходят за пределы нормы, если они есть).
    `;

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }
        });
        
        return JSON.parse(completion.choices[0].message.content);
    } catch (error) {
        console.error("Ошибка при генерации ИИ:", error);
        return null;
    }
}

// ИСПОЛЬЗУЕМ БОЛЕЕ МОЩНУЮ БИБЛИОТЕКУ
const PDFParser = require("pdf2json");

// Настройка multer для работы с памятью (не сохраняет файл на диск)
const storage = multer.memoryStorage(); 
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Только PDF файлы разрешены'), false);
        }
    }
});

// Маршрут для загрузки и обработки PDF
router.post('/upload', (req, res) => {
    upload.single('reportPdf')(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            console.error('Multer error:', err);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, error: 'Файл слишком большой (максимум 10MB)' });
            }
            return res.status(400).json({ success: false, error: 'Ошибка загрузки файла: ' + err.message });
        } else if (err) {
            console.error('Upload error:', err);
            return res.status(400).json({ success: false, error: err.message });
        }

        // Если ошибок нет, продолжаем обработку
        handlePdfUpload(req, res);
    });
});

// МАРШРУТ ДЛЯ ОТОБРАЖЕНИЯ СТРАНИЦЫ HEALTH VAULT
router.get('/health-vault/:id', async (req, res) => {
    try {
        // Создаем "полный" объект пользователя, чтобы хедер не ругался
        const mockUser = req.user ? req.user : { 
            _id: req.params.id, 
            full_name: "Guest User", // Добавляем это поле обязательно!
            email: "guest@example.com"
        };

        const mockAnalyses = [
            {
                _id: "69ab84ff21bb223b6d6a78a8",
                testType: "Общий анализ крови",
                testDate: new Date(),
                clinicName: "Meditrace Lab",
                contentType: "application/pdf",
                results: [
                    { name: "Гемоглобин", val: 140, unit: "г/л" },
                    { name: "Лейкоциты", val: 6.5, unit: "тыс/мкл" },
                    { name: "MCV", val: 88, unit: "фл" }
                ]
            },
            {
                _id: "mock_analysis_2",
                testType: "Биохимический анализ",
                testDate: new Date(Date.now() - 86400000), // Вчера
                clinicName: "City Lab",
                contentType: "application/pdf",
                results: [
                    { name: "Холестерин", val: 5.1, unit: "ммоль/л" },
                    { name: "Глюкоза", val: 4.9, unit: "ммоль/л" },
                    { name: "Креатинин", val: 89, unit: "мкмоль/л" }
                ]
            }
        ];

        res.render('health-vault', { 
            user: mockUser, 
            genres: [], // Пустой массив без БД
            loginUser: mockUser,
            blog: [], // Пустой массив без БД
            analyses: mockAnalyses // Передаем фейковые данные
        });

    } catch (error) {
        console.error("Ошибка при открытии Health Vault:", error);
        res.status(500).send("Ошибка сервера");
    }
});

// Функция обработки PDF
async function handlePdfUpload(req, res) {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не выбран' });
        }

        console.log('Загружен файл:', req.file.originalname);
        console.log('User ID from session:', req.session.userId);
        console.log('Is temp user:', req.session.isTempUser);
        console.log('File size:', req.file.buffer.length, 'bytes');

        let results = [];

        try {
            const pdfParser = new PDFParser(null, 1);

            // Создаем временный файл для парсинга (pdf2json требует файл)
            const tempPath = path.join(__dirname, '../../temp_' + Date.now() + '.pdf');
            require('fs').writeFileSync(tempPath, req.file.buffer);

            await new Promise((resolve, reject) => {
                pdfParser.on("pdfParser_dataError", errData => reject(new Error(errData.parserError)));
                pdfParser.on("pdfParser_dataReady", () => resolve());
                pdfParser.loadPDF(tempPath);
            });

            const rawText = pdfParser.getRawTextContent();
            console.log("Длина извлеченного текста:", rawText.length, "символов");

            // Удаляем временный файл
            require('fs').unlinkSync(tempPath);

            // Парсинг биомаркеров
            const lines = rawText.split('\n')
                .map(line => line.trim())
                .filter(line => {
                    return line.length > 0 &&
                        !line.startsWith("Warning:") &&
                        !line.includes("---Page") &&
                        !line.includes("Индивидуальный") &&
                        !line.includes("Науқас") &&
                        !line.includes("PAGE") &&
                        !line.includes("Page") &&
                        !line.match(/^\d+$/) && // Убираем строки с только цифрами
                        !line.match(/^[A-ZА-ЯЁё]+$/i); // Убираем строки с только заголовками
                });

            // Расширенный список анализов для поиска
            const targetAnalyses = [
                'Тестостерон', 'Кортизол', 'Гемоглобин', 'Холестерин', 'Глюкоза', 'Лейкоциты',
                'Эритроциты', 'Тромбоциты', 'Гематокрит', 'MCV', 'MCH', 'MCHC', 'RDW',
                'Нейтрофилы', 'Лимфоциты', 'Моноциты', 'Эозинофилы', 'Базофилы',
                'СОЭ', 'СРБ', 'Креатинин', 'Мочевина', 'Мочевая кислота',
                'Билирубин общий', 'Билирубин прямой', 'Билирубин непрямой',
                'АЛТ', 'АСТ', 'ЩФ', 'ГГТ', 'Амилаза',
                'Белок общий', 'Альбумин', 'Калий', 'Натрий', 'Хлор',
                'Кальций', 'Фосфор', 'Магний', 'Железо',
                'Тиреотропин', 'Т3 свободный', 'Т4 свободный', 'Т4 общий',
                'Пролактин', 'Эстрадиол', 'Прогестерон', 'ФСГ', 'ЛГ',
                'Витамин D', 'Витамин B12', 'Фолиевая кислота',
                'Триглицериды', 'ЛПНП', 'ЛПВП', 'ЛПОНП',
                'С-реактивный белок', 'Фибриноген', 'D-димер',
                'Инсулин', 'С-пептид', 'Гликированный гемоглобин'
            ];

            // 1. ИСПРАВЛЕННАЯ РЕГУЛЯРКА:
            // (.*?) - берет любые символы в названии (включая запятые и скобки)
            // круглые скобки (...) для точного совпадения единиц измерения
            const regex = /^(.*?)\s+(\d+[.,]?\d*)\s+(%|г\/л|млн\/мкл|фл|пг|г\/дл|тыс\/мкл|мм\/ч|нмоль\/л|ммоль\/л|мкмоль\/л|мкг\/л|мг\/дл|нг\/мл|мед\/л|ед\/л|т\/год|г\/%|мк\/л|ме\/л)(?:\s+(.*))?$/i;

            let allParsedData = [];
            let skipNext = false; // Флаг для пропуска склеенных строк

            // Проходим по строкам
            for (let i = 0; i < lines.length; i++) {
                if (skipNext) {
                    skipNext = false;
                    continue; 
                }

                // Убираем надстрочные знаки и чистим мусор
                let cleanLine = lines[i]
                    .replace(/ᴺᴬ/g, '')
                    .replace(/NA/g, '')
                    .replace(/^Клинический анализ крови\s*/i, '') 
                    .trim();
                
                // РАЗЛЕПЛЯЕМ слипшиеся скобки и цифры (например: "эр.)34.9" превращаем в "эр.) 34.9")
                cleanLine = cleanLine.replace(/\)(\d+[.,]?\d*)/g, ') $1');
                
                // Схлопываем множественные пробелы
                cleanLine = cleanLine.replace(/\s{2,}/g, ' ');

                let match = cleanLine.match(regex);
                
                let usedCombined = false;
                let combinedLineStr = "";

                // Пробуем склеить текущую строку со следующей
                if (!match && i < lines.length - 1) {
                    let nextCleanLine = lines[i+1].replace(/ᴺᴬ/g, '').replace(/NA/g, '').trim();
                    nextCleanLine = nextCleanLine.replace(/\)(\d+[.,]?\d*)/g, ') $1'); // Тоже разлепляем
                    combinedLineStr = cleanLine + " " + nextCleanLine;
                    match = combinedLineStr.replace(/\s{2,}/g, ' ').match(regex);
                    
                    if (match) {
                        skipNext = true; 
                        usedCombined = true;
                    }
                }

                if (match) {
                    let [_, name, value, unit, range] = match;
                    
                    let cleanName = name
                        .replace(/^\(Комментарий\)\s*/i, '') 
                        .trim(); 
                    
                    // Железобетонный хак для СОЭ (ищем по оригинальному сырому имени)
                    if (name.toLowerCase().includes('седиментацион') || name.toLowerCase().includes('соэ')) {
                        cleanName = 'СОЭ';
                    }

                    // Убираем оставшийся мусор по краям (например, висящие двоеточия)
                    cleanName = cleanName.replace(/^[^\wа-яА-ЯёЁ]+|[^\wа-яА-ЯёЁ]+$/g, ''); 

                    // Пропускаем мусор от ISSAM и проверяем длину
                    if (cleanName.length > 1 && !cleanName.includes('ISSAM')) {
                        allParsedData.push({
                            name: cleanName,
                            val: parseFloat(value.replace(',', '.')),
                            unit: unit.trim(),
                            reference: range ? range.trim() : ''
                        });
                    }
                }
            }

            console.log(`\n=== НАЙДЕНО БИОМАРКЕРОВ: ${allParsedData.length} ===`);
            allParsedData.forEach((item, index) => {
                console.log(`${index + 1}. ${item.name}: ${item.val} ${item.unit} ${item.reference ? '(' + item.reference + ')' : ''}`);
            });
            console.log("=====================================\n");

            // Функция для унификации похожих букв кириллицы и латиницы (МСНС / MCHC)
            const normalizeLetters = (str) => {
                return str.toLowerCase()
                    .replace(/м/g, 'm').replace(/с/g, 'c')
                    .replace(/н/g, 'h').replace(/в/g, 'v')
                    .replace(/о/g, 'o').replace(/а/g, 'a')
                    .replace(/р/g, 'p').replace(/е/g, 'e')
                    .replace(/х/g, 'x');
            };

            // УМНЫЙ ПОИСК ЦЕЛЕВЫХ АНАЛИЗОВ
            results = targetAnalyses.map(targetName => {
                const found = allParsedData.find(item => {
                    // Пропускаем названия через "переводчик" перед сравнением
                    const iName = normalizeLetters(item.name);
                    const tName = normalizeLetters(targetName);

                    // Строгая проверка: если ищем обычный гемоглобин, отсекаем гликированный
                    if (tName === 'гемоглобин' && iName.includes('гликирован')) return false;
                    
                    return iName.includes(tName);
                });

                if (found) {
                    return {
                        name: targetName,
                        val: found.val,
                        unit: found.unit,
                        reference: found.reference
                    };
                }
                return null;
            }).filter(item => item !== null);

            // Если целевых анализов мало, добавляем первые 10 найденных
            if (results.length < 5 && allParsedData.length > results.length) {
                const additionalAnalyses = allParsedData
                    .filter(item => !results.some(r => r.name.toLowerCase() === item.name.toLowerCase()))
                    .slice(0, 10 - results.length)
                    .map(item => ({
                        name: item.name,
                        val: item.val,
                        unit: item.unit,
                        reference: item.reference
                    }));
                
                results = [...results, ...additionalAnalyses];
            }

        } catch (parseErr) {
            console.warn("Парсинг PDF не удался:", parseErr.message);
        }

        // Вызываем ИИ и передаем ему результаты (независимо от сохранения в БД)
        const aiReport = await generateAISummary(results);

        // ДОБАВЬТЕ ЭТУ СТРОКУ:
        console.log("=== ОТВЕТ ОТ ИИ ===", JSON.stringify(aiReport, null, 2));

        // Сохраняем AI отчет в сессию для отображения во вкладке AI Health Coach
        req.session.aiReport = aiReport;

        // СНАЧАЛА СОХРАНЯЕМ В БАЗУ, ПОТОМ ОТПРАВЛЯЕМ ОТВЕТ
        if (results.length > 0) {
            // Вместо простой проверки, создадим надежный ID
            const effectiveUserId = (req.user && req.user._id) 
                ? req.user._id.toString() 
                : (req.session.userId || 'temp_user_1');

            try {
                const newAnalysis = new Analysis({
                    userId: effectiveUserId, // Используем вычисленный ID
                    testType: req.body.testType || "Invitro Report",
                    testDate: req.body.testDate || new Date().toISOString().split('T')[0],
                    results: results,
                    pdfData: req.file.buffer, // Сохраняем весь PDF файл в базу
                    contentType: req.file.mimetype,
                    fileName: req.file.originalname
                });

                await newAnalysis.save();
                console.log('✅ Анализ успешно сохранен в MongoDB с PDF файлом для userId:', effectiveUserId);

                // Вызываем ИИ и передаем ему результаты
                const aiReport = await generateAISummary(results);

                // Сохраняем AI отчет в сессию для отображения во вкладке AI Health Coach
                req.session.aiReport = aiReport;
            } catch (saveErr) {
                console.error('❌ Ошибка сохранения анализа в MongoDB:', saveErr);
                // Не прерываем процесс, продолжаем без сохранения в БД
            }
        }

        // ТОЛЬКО ТЕПЕРЬ ОТПРАВЛЯЕМ ОДИН ОТВЕТ
        const userId = (req.user && req.user._id) ? req.user._id : (req.session.userId || 'temp_user_1');
        
        // Если анализ не сохранен, выводим сообщение ДО отправки ответа
        if (results.length === 0) {
            console.log('❌ Анализ не сохранен. Причины:', {
                hasResults: results.length > 0,
                hasUserId: !!req.session.userId,
                hasReqUser: !!req.user,
                userId: req.session.userId
            });
        }
        
        return res.json({
            success: true,
            date: req.body.testDate || new Date().toISOString().split('T')[0],
            testType: req.body.testType || "Invitro Report",
            results: results
        });

    } catch (error) {
        console.error("Критическая ошибка:", error);
        // Проверяем, не отправили ли мы ответ ранее, чтобы не было повторного вызова
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: error.message });
        }
    }
};

router.get('/login', async (req, res) => {
    try {
        res.render('login', { 
            user: null, // На странице входа пользователя нет
            message: null
        });
    } catch (error) {
        console.error("Login page error:", error);
        res.status(500).send("Server Error");
    }
});

router.post('/api/signin', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // ВРЕМЕННАЯ АВТОРИЗАЦИЯ ДЛЯ ТЕСТИРОВАНИЯ
        if (email === 'turgazinkajsar@gmail.com' && password === '12') {
            req.session.userId = 'temp_user_1';
            req.session.isTempUser = true;
            
            // Добавляем return, чтобы остановить дальнейшее выполнение функции!
            return req.session.save((err) => {
                if (err) {
                    console.error('Session save error:', err);
                    return res.status(500).json({ 
                        success: false, 
                        error: 'Ошибка сессии' 
                    });
                }
                console.log('✅ Temporary user logged in:', email);
                return res.redirect('/health-vault/temp_user_1');
            });
        }
        
        // ВРЕМЕННАЯ АВТОРИЗАЦИЯ ДЛЯ ЛЮБОГО ПОЛЬЗОВАТЕЛЯ
        else if (email && password) { // Используем else if
            const mockUserId = 'mock_' + Date.now();
            req.session.userId = mockUserId;
            req.session.isTempUser = false;
            
            // Добавляем return!
            return req.session.save((err) => {
                if (err) {
                    console.error('Session save error:', err);
                    return res.status(500).json({ 
                        success: false, 
                        error: 'Ошибка сессии' 
                    });
                }
                console.log('✅ Mock user logged in:', email);
                return res.redirect(`/health-vault/${mockUserId}`);
            });
        }
        
        // Ошибка авторизации (выполнится только если не сработали условия выше)
        return res.json({ 
            success: false, 
            error: 'Неверный email или пароль' 
        });
        
    } catch (error) {
        console.error("Signin error:", error);
        if (!res.headersSent) { // Дополнительная защита
            res.status(500).json({ success: false, error: 'Ошибка сервера' });
        }
    }
});

router.get('/profile/:id', async (req, res) => {
    try {
        const mockUser = { 
            _id: req.params.id, 
            full_name: "Guest User",
            email: "guest@example.com"
        };
        
        res.render('profile', { 
            user: mockUser,
            genres: [],
            loginUser: mockUser,
            blog: []
        });
    } catch (error) {
        console.error("Profile error:", error);
        res.status(500).send("Server Error");
    }
});

router.get('/add-members/:id', async (req, res) => {
    try {
        const mockUser = { 
            _id: req.params.id, 
            full_name: "Guest User",
            email: "guest@example.com"
        };
        
        res.render('addMembers', { 
            user: mockUser,
            genres: []
        });
    } catch (error) {
        console.error("Add members error:", error);
        res.status(500).send("Server Error");
    }
});

router.get('/setting/:id', async (req, res) => {
    try {
        const mockUser = { 
            _id: req.params.id, 
            full_name: "Guest User",
            email: "guest@example.com"
        };
        
        res.render('setting', { 
            user: mockUser,
            genres: []
        });
    } catch (error) {
        console.error("Settings error:", error);
        res.status(500).send("Server Error");
    }
});

router.get('/api/signout', (req, res) => {
    try {
        req.session.destroy((err) => {
            if (err) {
                console.error("Session destroy error:", err);
                return res.status(500).send("Logout error");
            }
            res.redirect('/login');
        });
    } catch (error) {
        console.error("Signout error:", error);
        res.status(500).send("Server Error");
    }
});

router.get('/pdf-upload-page/:id?', async function (req, res) {
    try {
        const mockUser = { 
            _id: req.params.id || 'temp_user_1', 
            full_name: "Guest User",
            email: "guest@example.com"
        };
        
        res.render("upload", { 
            user: mockUser
        });
    } catch (error) {
        console.error("Upload page error:", error);
        res.status(500).send("Server Error");
    }
});

// Маршрут для скачивания PDF из MongoDB
router.get('/download-pdf/:id', async (req, res) => {
    try {
        // ВРЕМЕННО: Вместо поиска в БД отдаем тестовый PDF
        const mockPdfData = Buffer.from('Mock PDF content for testing');
        const mockFileName = 'test_analysis.pdf';
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${encodeURI(mockFileName)}`);
        res.send(mockPdfData);
    } catch (err) {
        console.error('Ошибка при скачивании PDF:', err);
        res.status(500).send('Ошибка при скачивании');
    }
});

// Маршрут для получения AI отчета
router.get('/ai-report', (req, res) => {
    try {
        const aiReport = req.session.aiReport;
        const bloodResults = req.session.bloodResults;
        
        if (!aiReport) {
            return res.json({ 
                success: false, 
                message: "AI отчет не найден. Загрузите PDF файл сначала." 
            });
        }
        
        res.json({ 
            success: true, 
            aiReport: aiReport,
            bloodResults: bloodResults
        });
    } catch (error) {
        console.error("AI report error:", error);
        res.status(500).json({ 
            success: false, 
            message: "Ошибка получения AI отчета" 
        });
    }
});

module.exports = router;