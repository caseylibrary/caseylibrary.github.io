import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { 
    getFirestore, 
    doc, 
    onSnapshot, 
    collection, 
    updateDoc, 
    increment,
    setDoc,
    query,
    where,
    getDocs,
    limit,
    orderBy,
    startAfter,
    endBefore,
    Timestamp,
    serverTimestamp,
    runTransaction,
    setLogLevel
} from 'firebase/firestore';

// Set logging level for debugging Firebase operations
setLogLevel('error');

// --- Global Variables (Mandatory for Canvas Environment) ---
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-ref-tally-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// The current date in YYYY-MM-DD format for use as a document ID
const getTodayDateId = () => {
    return new Date().toISOString().slice(0, 10);
};

// --- Question Categories and Descriptions ---
const QUESTION_TYPES = [
    { 
        id: 'directional', 
        name: 'Directional', 
        color: 'bg-indigo-500 hover:bg-indigo-600', 
        description: 'Asking for physical locations within the building.',
        example: 'Example: "Where is the printer?" or "Is the bathroom on this floor?"'
    },
    { 
        id: 'quick_fact', 
        name: 'Quick Fact/Ready Ref.', 
        color: 'bg-emerald-500 hover:bg-emerald-600', 
        description: 'Simple questions answerable with a quick search or readily available fact.',
        example: 'Example: "What year did X author win that award?" or "What is the phone number for the city council?"'
    },
    { 
        id: 'procedural', 
        name: 'Policy/Procedural', 
        color: 'bg-rose-500 hover:bg-rose-600', 
        description: 'Questions about rules, services, or how to use a basic service.',
        example: 'Example: "How long can I borrow this?" or "Can I reserve a study room?"'
    },
    { 
        id: 'research', 
        name: 'Research/Complex', 
        color: 'bg-amber-500 hover:bg-amber-600', 
        description: 'In-depth assistance requiring search strategy, source evaluation, or specialized tools.',
        example: 'Example: "I need to find five scholarly articles on climate policy." or "Help me narrow down this topic."'
    },
    { 
        id: 'technology', 
        name: 'Technology/Equip.', 
        color: 'bg-sky-500 hover:bg-sky-600', 
        description: 'Troubleshooting or instruction on public equipment and software.',
        example: 'Example: "How do I scan this document?" or "My laptop won\'t connect to the Wi-Fi."'
    },
];

// Utility function to convert data to CSV string
const convertToCSV = (data) => {
    if (data.length === 0) return '';
    
    const headers = Object.keys(data[0]);
    const csvRows = [];
    
    // Add headers
    csvRows.push(headers.join(','));
    
    // Add data rows
    for (const row of data) {
        const values = headers.map(header => {
            const value = row[header];
            // Handle quotes and commas in strings
            const escaped = ('' + value).replace(/"/g, '""');
            return `"${escaped}"`;
        });
        csvRows.push(values.join(','));
    }
    
    return csvRows.join('\n');
};

const App = () => {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [dailyCounts, setDailyCounts] = useState({});
    const [weeklySummary, setWeeklySummary] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [hoveredType, setHoveredType] = useState(null);
    const [isPrinting, setIsPrinting] = useState(false); // To hide non-report elements during print

    const TODAY_DATE = getTodayDateId();
    const DATA_COLLECTION_PATH = `artifacts/${appId}/public/data/daily_ref_counts`;

    // 1. Initialize Firebase and Authentication
    useEffect(() => {
        try {
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const authService = getAuth(app);
            setDb(firestore);
            setAuth(authService);

            const unsubscribe = onAuthStateChanged(authService, async (user) => {
                if (user) {
                    setUserId(user.uid);
                } else {
                    // Sign in using the custom token if available, otherwise anonymously
                    if (initialAuthToken) {
                        await signInWithCustomToken(authService, initialAuthToken);
                        setUserId(authService.currentUser?.uid);
                    } else {
                        await signInAnonymously(authService);
                        setUserId(authService.currentUser?.uid || crypto.randomUUID());
                    }
                }
                setIsAuthReady(true);
                setLoading(false);
            });

            return () => unsubscribe();
        } catch (e) {
            console.error("Firebase initialization failed:", e);
            setError("Failed to initialize the app. Check console for details.");
            setLoading(false);
        }
    }, []);

    // 2. Real-time Daily Data Listener
    useEffect(() => {
        if (!db || !isAuthReady) return;

        const docRef = doc(db, DATA_COLLECTION_PATH, TODAY_DATE);

        const unsubscribe = onSnapshot(docRef, (docSnap) => {
            if (docSnap.exists()) {
                // Update daily counts with live data
                setDailyCounts(docSnap.data());
            } else {
                // Document doesn't exist yet, initialize counts to zero
                setDailyCounts(QUESTION_TYPES.reduce((acc, type) => ({ ...acc, [type.id]: 0 }), {}));
            }
        }, (err) => {
            console.error("Error listening to daily counts:", err);
            setError("Could not load real-time data.");
        });

        // Clean up listener on component unmount
        return () => unsubscribe();
    }, [db, isAuthReady, TODAY_DATE]);

    // 3. Data Tally Handler
    const handleCount = async (typeId) => {
        if (!db) {
            setError("Database not connected.");
            return;
        }

        const docRef = doc(db, DATA_COLLECTION_PATH, TODAY_DATE);

        try {
            await runTransaction(db, async (transaction) => {
                const docSnap = await transaction.get(docRef);

                if (!docSnap.exists()) {
                    // If the document doesn't exist, create it with initial counts
                    const initialData = QUESTION_TYPES.reduce((acc, type) => ({ ...acc, [type.id]: 0 }), {});
                    transaction.set(docRef, { 
                        ...initialData, 
                        [typeId]: 1,
                        createdAt: serverTimestamp(),
                        lastUpdatedBy: userId,
                        date: TODAY_DATE
                    });
                } else {
                    // Document exists, atomically increment the specific type
                    transaction.update(docRef, { 
                        [typeId]: increment(1),
                        lastUpdatedBy: userId,
                        updatedAt: serverTimestamp()
                    });
                }
            });
            // Clear any previous error
            setError(null);
        } catch (e) {
            console.error("Transaction failed:", e);
            setError("Failed to record count. Please check connection.");
        }
    };

    // 4. Weekly Data Aggregation (Fetch on load and when dailyCounts change)
    const fetchWeeklySummary = async () => {
        if (!db || !isAuthReady) return;

        setLoading(true);
        try {
            const today = new Date();
            const oneWeekAgo = new Date();
            // Go back 6 days to include today (7 days total)
            oneWeekAgo.setDate(today.getDate() - 6); 

            // Format YYYY-MM-DD
            const oneWeekAgoId = oneWeekAgo.toISOString().slice(0, 10);
            
            // Note: Firestore queries are complex for "between dates" by string, 
            // but for ID-based date strings (YYYY-MM-DD), they work for range.
            const collectionRef = collection(db, DATA_COLLECTION_PATH);
            
            // Query for documents where the ID (date string) is greater than or equal to 7 days ago.
            // We order by document ID (date string) to get the correct chronological order.
            const q = query(
                collectionRef,
                orderBy('date', 'desc'), // Order by date descending
                limit(7) // Limit to the last 7 documents (assuming continuous daily logging)
            );

            const querySnapshot = await getDocs(q);
            const weeklyData = [];
            
            querySnapshot.forEach(doc => {
                weeklyData.push({
                    date: doc.id,
                    ...doc.data()
                });
            });

            // Sort ascending to make the report look chronological
            weeklyData.sort((a, b) => a.date.localeCompare(b.date));
            setWeeklySummary(weeklyData);
            setLoading(false);

        } catch (e) {
            console.error("Error fetching weekly summary:", e);
            setError("Failed to load weekly report data.");
            setLoading(false);
        }
    };

    // Fetch the weekly data once auth is ready and whenever the current day's data updates
    useEffect(() => {
        if (isAuthReady && db) {
            fetchWeeklySummary();
        }
    }, [isAuthReady, db, dailyCounts]); 

    // Calculate total summary for the week
    const weeklyTotals = useMemo(() => {
        return weeklySummary.reduce((totals, day) => {
            QUESTION_TYPES.forEach(type => {
                const count = day[type.id] || 0;
                totals[type.id] = (totals[type.id] || 0) + count;
                totals.grandTotal = (totals.grandTotal || 0) + count;
            });
            return totals;
        }, { grandTotal: 0 });
    }, [weeklySummary]);


    // 5. Reporting and Export Functions
    const handlePrint = () => {
        setIsPrinting(true);
        // Delay print slightly to ensure React re-renders with the printing state
        setTimeout(() => {
            window.print();
            setIsPrinting(false);
        }, 100);
    };

    const handleExportCSV = () => {
        const reportData = weeklySummary.map(day => {
            const row = { 'Date': day.date };
            QUESTION_TYPES.forEach(type => {
                row[type.name] = day[type.id] || 0;
            });
            return row;
        });

        // Add a totals row at the end
        const totalsRow = { 'Date': 'TOTAL WEEKLY COUNT' };
        QUESTION_TYPES.forEach(type => {
            totalsRow[type.name] = weeklyTotals[type.id] || 0;
        });
        reportData.push(totalsRow);

        const csvString = convertToCSV(reportData);
        
        // Download the CSV file
        const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        if (link.download !== undefined) {
            const url = URL.createObjectURL(blob);
            link.setAttribute("href", url);
            link.setAttribute("download", `ref_question_log_${TODAY_DATE}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } else {
            // Replaced alert with console message as per instructions
            console.error("Your browser does not support downloading files directly.");
        }
    };

    if (loading && !isAuthReady) {
        return (
            <div className="flex justify-center items-center h-screen bg-gray-50">
                <div className="text-xl text-gray-700">Connecting to secure server...</div>
            </div>
        );
    }
    
    // UI Rendering
    return (
        <div className="min-h-screen bg-gray-50 font-sans p-4 md:p-8" style={{ fontFamily: 'Inter, sans-serif' }}>
            {/* The main tally controls, hidden during printing */}
            {!isPrinting && (
                <div className="max-w-4xl mx-auto">
                    <header className="text-center mb-8">
                        <h1 className="text-4xl font-extrabold text-indigo-700 mb-2">Reference Question Tally</h1>
                        <p className="text-gray-600">
                            Live count for {TODAY_DATE}. User ID: <code className="text-xs bg-gray-200 p-1 rounded">{userId}</code>
                        </p>
                        {error && <p className="mt-4 p-2 bg-red-100 text-red-700 rounded-lg font-medium">{error}</p>}
                    </header>

                    {/* Question Counting Buttons */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
                        {QUESTION_TYPES.map((type) => (
                            <button
                                key={type.id}
                                className={`
                                    flex flex-col items-center justify-center p-4 rounded-xl shadow-lg 
                                    text-white transition-all transform active:scale-[0.98] 
                                    focus:outline-none focus:ring-4 focus:ring-opacity-50
                                    ${type.color} focus:ring-indigo-300
                                    relative overflow-hidden
                                `}
                                onClick={() => handleCount(type.id)}
                                onMouseEnter={() => setHoveredType(type.id)}
                                onMouseLeave={() => setHoveredType(null)}
                            >
                                <span className="text-5xl font-bold mb-1">
                                    {dailyCounts[type.id] || 0}
                                </span>
                                <span className="text-xl font-semibold uppercase tracking-wider">
                                    {type.name}
                                </span>
                                
                                {/* Hover Description Overlay */}
                                <div 
                                    className={`
                                        absolute inset-0 bg-gray-900 bg-opacity-90 flex flex-col justify-center items-center p-4 rounded-xl 
                                        transition-opacity duration-300 pointer-events-none 
                                        ${hoveredType === type.id ? 'opacity-100' : 'opacity-0'}
                                    `}
                                >
                                    <p className="text-sm font-light text-gray-200 text-center mb-2">{type.description}</p>
                                    <p className="text-xs italic text-gray-400 text-center">{type.example}</p>
                                </div>
                            </button>
                        ))}
                    </div>

                    {/* Report Controls */}
                    <div className="flex justify-center space-x-4 mb-8">
                        <button
                            onClick={handleExportCSV}
                            className="flex items-center px-6 py-3 bg-teal-500 text-white font-semibold rounded-lg shadow-md hover:bg-teal-600 transition-colors"
                        >
                            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                            Export CSV
                        </button>
                        <button
                            onClick={handlePrint}
                            className="flex items-center px-6 py-3 bg-gray-700 text-white font-semibold rounded-lg shadow-md hover:bg-gray-800 transition-colors"
                        >
                            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 17h2a2 2 0 002-2v-5a2 2 0 00-2-2H5a2 2 0 00-2 2v5a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-2a2 2 0 00-2-2H9a2 2 0 00-2 2v2a2 2 0 002 2zm2-13V7a2 2 0 012-2h2a2 2 0 012 2v3"></path></svg>
                            Print Report
                        </button>
                    </div>
                </div>
            )}

            {/* Daily and Weekly Summary Report (Visible always, print-optimized) */}
            <div className="max-w-4xl mx-auto bg-white p-6 rounded-xl shadow-2xl border border-gray-100 print:shadow-none print:border-0">
                <h2 className="text-3xl font-bold text-gray-800 border-b pb-3 mb-4 print:text-center print:text-black">
                    Reference Question Summary Report
                </h2>

                <div className="mb-6">
                    <h3 className="text-xl font-semibold text-indigo-600 mb-3">Daily Totals: {TODAY_DATE}</h3>
                    <div className="grid grid-cols-2 gap-4 text-center">
                        {QUESTION_TYPES.map(type => (
                            <div key={`daily-${type.id}`} className="p-3 bg-indigo-50 rounded-lg shadow-sm">
                                <p className="text-lg font-medium text-gray-700">{type.name}</p>
                                <p className="text-3xl font-extrabold text-indigo-700">{dailyCounts[type.id] || 0}</p>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="mb-6">
                    <h3 className="text-xl font-semibold text-teal-600 mb-3 border-t pt-4">Weekly Aggregation</h3>
                    <div className="grid grid-cols-2 gap-4">
                        <div className="col-span-2 md:col-span-1 bg-teal-50 p-4 rounded-lg shadow-sm">
                             <p className="text-xl font-medium text-gray-700">Grand Total (Last {weeklySummary.length} Days)</p>
                             <p className="text-4xl font-extrabold text-teal-700">{weeklyTotals.grandTotal}</p>
                        </div>
                        <div className="col-span-2 md:col-span-1 bg-teal-50 p-4 rounded-lg shadow-sm">
                            <p className="text-xl font-medium text-gray-700">Report Period</p>
                            <p className="text-base font-semibold text-teal-700 mt-2">
                                {weeklySummary.length > 0 
                                    ? `${weeklySummary[0].date} to ${weeklySummary[weeklySummary.length - 1].date}`
                                    : 'No data available'}
                            </p>
                        </div>
                    </div>
                </div>

                {/* Detailed Weekly Breakdown Table */}
                <h3 className="text-xl font-semibold text-gray-700 border-t pt-4 mb-3">Day-by-Day Breakdown</h3>
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                                {QUESTION_TYPES.map(type => (
                                    <th key={type.id} className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">{type.name}</th>
                                ))}
                                <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase tracking-wider bg-gray-100">Daily Total</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {weeklySummary.map((day) => {
                                const dailyTotal = QUESTION_TYPES.reduce((sum, type) => sum + (day[type.id] || 0), 0);
                                return (
                                    <tr key={day.date}>
                                        <td className="px-3 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{day.date}</td>
                                        {QUESTION_TYPES.map(type => (
                                            <td key={`${day.date}-${type.id}`} className="px-3 py-4 whitespace-nowrap text-right text-sm text-gray-500">
                                                {day[type.id] || 0}
                                            </td>
                                        ))}
                                        <td className="px-3 py-4 whitespace-nowrap text-right text-sm font-bold text-gray-800 bg-gray-50">{dailyTotal}</td>
                                    </tr>
                                );
                            })}
                            {/* Totals Row */}
                            <tr className="bg-indigo-50 font-bold border-t-2 border-indigo-200">
                                <td className="px-3 py-4 whitespace-nowrap text-sm text-gray-900">WEEKLY TOTAL</td>
                                {QUESTION_TYPES.map(type => (
                                    <td key={`total-${type.id}`} className="px-3 py-4 whitespace-nowrap text-right text-sm text-indigo-800">
                                        {weeklyTotals[type.id] || 0}
                                    </td>
                                ))}
                                <td className="px-3 py-4 whitespace-nowrap text-right text-sm text-indigo-800 bg-indigo-100">{weeklyTotals.grandTotal}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Custom Print Styles */}
            <style>{`
                /* Hide elements that shouldn't appear in the printed report */
                @media print {
                    body {
                        background-color: #fff !important;
                    }
                    /* Hide everything except the main report area */
                    .min-h-screen > :not(.max-w-4xl) {
                        display: none;
                    }
                    .max-w-4xl {
                        max-width: none !important; /* Use full width for print */
                        margin: 0 !important;
                        padding: 0 !important;
                        box-shadow: none !important;
                    }
                    h2, h3 {
                        color: #000 !important;
                    }
                    .print\\:shadow-none {
                        box-shadow: none !important;
                    }
                    .print\\:border-0 {
                        border: none !important;
                    }
                    .print\\:text-center {
                        text-align: center !important;
                    }
                    table {
                        border-collapse: collapse;
                        width: 100%;
                    }
                    th, td {
                        border: 1px solid #ddd;
                        padding: 8px;
                    }
                }
            `}</style>
        </div>
    );
}

export default App;
