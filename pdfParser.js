const PDFParser = require("pdf2json");
const path = require("path");
const fs = require("fs");

/**
 * Парсит PDF файл и извлекает биомаркеры
 * @param {Buffer} pdfBuffer - Буфер PDF файла
 * @returns {Promise<Array>} - Массив найденных биомаркеров
 */
async function parsePDF(pdfBuffer) {
    try {
        const pdfParser = new PDFParser(null, 1);

        // Создаем временный файл для парсинга (pdf2json требует файл)
        const tempPath = path.join(__dirname, '../../temp_' + Date.now() + '.pdf');
        fs.writeFileSync(tempPath, pdfBuffer);

        await new Promise((resolve, reject) => {
            pdfParser.on("pdfParser_dataError", errData => reject(new Error(errData.parserError)));
            pdfParser.on("pdfParser_dataReady", () => resolve());
            pdfParser.loadPDF(tempPath);
        });

        const rawText = pdfParser.getRawTextContent();
        console.log("Длина извлеченного текста:", rawText.length, "символов");

        // Удаляем временный файл
        fs.unlinkSync(tempPath);

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
        let results = targetAnalyses.map(targetName => {
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

        return results;

    } catch (parseErr) {
        console.warn("Парсинг PDF не удался:", parseErr.message);
        return [];
    }
}

module.exports = {
    parsePDF
};
