## ⚙️ Environment Setup

### Prerequisites

- Python 3.8  
- Conda (recommended)  
- Java (for CoreNLP)

---

### Install CoreNLP

Download [Stanford CoreNLP](http://nlp.stanford.edu/software/stanford-corenlp-full-2018-10-05.zip)  
and unzip it to:

```
./third_party
```

Start the CoreNLP server:

```bash
apt install default-jre
apt install default-jdk
cd third_party/stanford-corenlp-full-2018-10-05
nohup java -mx4g -cp "*" edu.stanford.nlp.pipeline.StanfordCoreNLPServer &
cd ../../
```

---

### Python Environment Setup

```bash
conda create -n DAIL-SQL python=3.8
conda activate DAIL-SQL
python -m pip install --upgrade pip
pip install -r requirements.txt
python nltk_downloader.py
```

---

## 🚀 Run Backend API Server

This project provides a backend API service for NL2SQL.

Start the server:

```bash
python api_server.py
```

Make sure the server is running before using the frontend.

---

## 🔗 Frontend Integration

This backend is designed to work with the following frontend project:

👉 https://github.com/lucas-xu51/nl2sql-plugin  

To run the frontend:

```bash
npm install
npm run compile
```

Then open in VS Code:

- Press `F5` (or `Fn + F5`)
- Launch in debug mode

---

## 📌 Notes

- Ensure CoreNLP server is running before starting the API  
- Backend must be running before frontend sends requests  
