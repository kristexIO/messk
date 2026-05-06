import 'dart:io';

import 'package:path/path.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../models/message.dart';

class DatabaseService {
  Database? _db;
  String? _databasePath;

  Future<Database> get database async {
    if (_db != null) return _db!;
    _db = await _initDb();
    return _db!;
  }

  String? get databasePath => _databasePath;

  Future<Database> _initDb() async {
    if (Platform.isWindows || Platform.isLinux) {
      sqfliteFfiInit();
      databaseFactory = databaseFactoryFfi;
    }

    final docsDir = await getApplicationDocumentsDirectory();
    final path = join(docsDir.path, 'messk_v1.db');
    _databasePath = path;

    return await openDatabase(
      path,
      version: 2,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            sender_id TEXT NOT NULL,
            recipient_id TEXT NOT NULL,
            peer_id TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            status TEXT NOT NULL
          )
        ''');
        await db.execute(
          'CREATE INDEX idx_messages_peer_timestamp ON messages(peer_id, timestamp DESC)',
        );

        await db.execute('''
          CREATE TABLE contacts (
            id TEXT PRIMARY KEY,
            public_key TEXT NOT NULL,
            display_name TEXT,
            last_seen INTEGER
          )
        ''');
      },
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await db.execute(
            "ALTER TABLE messages ADD COLUMN peer_id TEXT NOT NULL DEFAULT ''",
          );
          await db.execute(
            "UPDATE messages SET peer_id = recipient_id WHERE peer_id = ''",
          );
          await db.execute(
            'CREATE INDEX IF NOT EXISTS idx_messages_peer_timestamp ON messages(peer_id, timestamp DESC)',
          );
        }
      },
    );
  }

  Future<void> initialize() async {
    await database;
  }

  Future<void> saveMessage(Message message) async {
    final db = await database;
    await db.insert(
      'messages',
      message.toMap(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<List<Message>> getMessagesForPeer({
    required String peerId,
    required String currentUserId,
  }) async {
    final db = await database;
    final rows = await db.query(
      'messages',
      where: 'peer_id = ?',
      whereArgs: [peerId],
      orderBy: 'timestamp DESC',
    );
    return rows
        .map((row) => Message.fromMap(row, currentUserId))
        .toList(growable: false);
  }
}
