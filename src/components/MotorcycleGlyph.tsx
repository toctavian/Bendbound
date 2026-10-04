import { Image } from 'react-native';
import { motorcycleTypeOrDefault } from '@/data/motorcycles';
import type { MotorcycleType } from '@/types';

const sprites = {
  sports: require('../../assets/motorcycles/sports.png'),
  adventure: require('../../assets/motorcycles/adventure.png'),
  cruiser: require('../../assets/motorcycles/cruiser.png'),
  motocross: require('../../assets/motorcycles/motocross.png'),
  funventure: require('../../assets/motorcycles/funventure.png'),
  bogdan: require('../../assets/motorcycles/bogdan.png'),
  radu: require('../../assets/motorcycles/radu.png'),
  petre: require('../../assets/motorcycles/petre.png'),
  foca: require('../../assets/motorcycles/foca.png'),
  scooter: require('../../assets/motorcycles/scooter.png'),
} satisfies Record<MotorcycleType, number>;

// All assets face north; the map rotates the enclosing view with the rider's heading.
export function MotorcycleGlyph({ type, size = 42 }: { type: MotorcycleType; size?: number }) {
  return (
    <Image
      accessible={false}
      fadeDuration={0}
      resizeMode="contain"
      source={sprites[motorcycleTypeOrDefault(type)]}
      style={{ height: size, width: size }}
    />
  );
}
