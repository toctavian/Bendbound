// Use a distinct entry name so Metro cannot resolve the legacy index.ts scaffold.
// Register background tasks before mounting any routes or React components.
import './src/services/rideTracking';
import 'expo-router/entry';
